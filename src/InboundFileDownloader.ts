/**
 * Inbound File Downloader (v1.9)
 *
 * Fetches sync-artifact items from the server files index and writes them
 * to the local vault. Called by InboundSyncPoller when web_content_updated_at bumps.
 */

import { normalizePath, Notice, TFile, Vault } from "obsidian";
import { dirname, join } from "path-browserify";
import { curryLog } from "./debug";
import { isExcludedPath } from "./vaultScope";
import { generateHash } from "./hashing";
import type { RelayOnPremShareClientManager } from "./RelayOnPremShareClientManager";
import type { WebSyncManager } from "./WebSyncManager";

const log = curryLog("[InboundFileDownloader]");

export class InboundFileDownloader {
	private vault: Vault;
	private clientManager: RelayOnPremShareClientManager;
	private webSyncManager: WebSyncManager;

	// Map<shareId, Record<relativePath, sha256>> — last sha256 we wrote per file.
	// Injectable (TR-02, #307f52bf) so callers can back it with LocalStorage
	// (vault-scoped, persisted) instead of a bare in-memory Map — an in-memory-only
	// manifest resets to empty on every plugin reload, which made the "is this a
	// user edit?" guard below never fire right after a restart. Defaults to a plain
	// Map for callers (incl. tests) that don't need persistence.
	private lastWrittenHash: Map<string, Record<string, string>>;
	// Vault paths currently being written — echo-loop guard for vault "modify" events
	private writingPaths: Set<string> = new Set();
	// Where a share lives locally, which is not always where the server thinks
	// it does. A vault share sits at the root and carries the vault's name on
	// the server, so joining that name onto every path would file the whole
	// vault inside a folder named after itself. Returns undefined when the
	// caller has nothing to say, and the server's own path is used.
	private localRootFor?: (shareId: string) => string | undefined;

	constructor(
		vault: Vault,
		clientManager: RelayOnPremShareClientManager,
		webSyncManager: WebSyncManager,
		hashManifestStore: Map<string, Record<string, string>> = new Map(),
		localRootFor?: (shareId: string) => string | undefined,
	) {
		this.vault = vault;
		this.clientManager = clientManager;
		this.webSyncManager = webSyncManager;
		this.lastWrittenHash = hashManifestStore;
		this.localRootFor = localRootFor;
	}

	/**
	 * Returns true while a file is being written by this downloader.
	 * main.ts checks this to suppress outbound sync echo.
	 */
	isInboundWriting(vaultPath: string): boolean {
		return this.writingPaths.has(vaultPath);
	}

	/**
	 * Main entry point — called by InboundSyncPoller when web_content_updated_at bumps.
	 * Resolves the share path, fetches the files index, diffs, and writes new/updated items.
	 * Returns "skipped" when outbound sync is in flight so the poller can retry.
	 */
	async downloadShare(shareId: string, serverId: string): Promise<"ran" | "skipped"> {
		if (this.webSyncManager.isOutboundSyncing) {
			log("Skipping — outbound sync in flight", { shareId });
			return "skipped";
		}

		// Where this share lands locally. The share's own path is the server's
		// answer; a vault share overrides it with the root.
		let sharePath: string;
		// Who said where the share lives matters. Our own resolver may answer
		// with the root, because a vault share genuinely has no prefix. The
		// server may not: an empty path from them is a bug or worse, and it
		// still fails closed below.
		let rootIsLocal = false;
		try {
			const share = await this.clientManager.getShare(serverId, shareId);
			const localRoot = this.localRootFor?.(shareId);
			rootIsLocal = localRoot !== undefined;
			sharePath = rootIsLocal ? (localRoot as string) : share.path;
		} catch (err: unknown) {
			log("Failed to resolve share path", {
				shareId,
				error: err instanceof Error ? err.message : String(err),
			});
			return "ran";
		}

		let items;
		try {
			items = await this.clientManager.getFilesIndex(serverId, shareId);
		} catch (err: unknown) {
			log("Failed to fetch files index", {
				shareId,
				error: err instanceof Error ? err.message : String(err),
			});
			return "ran";
		}

		// Filter to sync-artifact type only (server may return all types)
		const syncItems = items.filter(
			(item) => !item.type || item.type === "sync-artifact",
		);

		if (syncItems.length === 0) {
			log("No sync-artifact items in files index", { shareId });
			return "ran";
		}

		const shareManifest = { ...(this.lastWrittenHash.get(shareId) ?? {}) };

		for (const item of syncItems) {
			await this._downloadItem(
				item.path,
				item.sha256,
				shareId,
				serverId,
				sharePath,
				shareManifest,
				rootIsLocal,
			);
		}

		this.lastWrittenHash.set(shareId, shareManifest);
		return "ran";
	}

	private async _downloadItem(
		relativePath: string,
		serverSha256: string,
		shareId: string,
		serverId: string,
		sharePath: string,
		shareManifest: Record<string, string>,
		rootIsLocal: boolean,
	): Promise<void> {
		const vaultPath = normalizePath(join(sharePath, relativePath));

		// A server-supplied relativePath like "../../.obsidian/plugins/evil.js"
		// must never reach the disk. Two guards, and which one applies depends
		// on the scope.
		//
		// The exclusion list applies to both: no dot segment, no traversal. It
		// used to be absent here, and an empty sharePath failed closed instead,
		// which is right for a folder share and wrong for a vault share, whose
		// root IS the empty string. A vault share would have downloaded
		// nothing, silently.
		if (isExcludedPath(vaultPath, this.vault.configDir)) {
			log("Refusing a path outside what a share may touch", {
				relativePath,
				vaultPath,
				shareId,
			});
			return;
		}
		// Containment on top, for a folder share, which is also protected by
		// its own prefix. A vault share has no prefix, and the line above is
		// what stands in for it.
		const normalizedShare = normalizePath(sharePath);
		if (sharePath === "" && !rootIsLocal) {
			// share.path from the server, empty. Containment would be disabled
			// entirely and nobody here asked for the root, so fail closed.
			log("Path traversal rejected: empty sharePath", { relativePath, shareId });
			return;
		}
		if (sharePath !== "") {
			const withinShare =
				vaultPath === normalizedShare || vaultPath.startsWith(normalizedShare + "/");
			if (!withinShare) {
				log("Path traversal rejected", { relativePath, vaultPath, sharePath });
				return;
			}
		}

		const lastHash = shareManifest[relativePath];

		// Skip if sha256 unchanged since last download
		if (lastHash === serverSha256) {
			return;
		}

		// Guard against overwriting user edits (TR-02, #307f52bf):
		// If the file exists locally, check it against `lastHash` — what we last
		// wrote for this path — regardless of whether `lastHash` is defined. It
		// used to only check `if (lastHash)`, so a manifest with no recorded
		// history for this path (in-memory manifest wiped on every plugin
		// reload, or genuinely never synced before) skipped the check entirely
		// and downloaded straight over whatever was on disk. Now: known history
		// that doesn't match local content -> user edit, skip. No history at all
		// but the local file doesn't match what we're about to write -> unknown
		// provenance, ALSO skip rather than assume it's safe to overwrite.
		const abstractFile = this.vault.getAbstractFileByPath(vaultPath);
		if (abstractFile instanceof TFile) {
			// Only the read + hash computation is I/O that can legitimately fail;
			// the notify-and-skip decision below is not wrapped, so a bug there
			// surfaces as itself instead of being mislabeled a read failure.
			let localHash: string;
			try {
				const localBytes = await this.vault.readBinary(abstractFile);
				localHash = await generateHash(localBytes);
			} catch (err: unknown) {
				log("Could not read existing file, skipping to avoid data loss", {
					vaultPath,
					error: err instanceof Error ? err.message : String(err),
				});
				return;
			}
			const expectedHash = lastHash ?? serverSha256;
			if (localHash !== expectedHash) {
				log("Skipping user-edited (or unknown-provenance) file", {
					vaultPath,
					localHash,
					lastWritten: lastHash ?? "(none recorded)",
					serverHash: serverSha256,
				});
				new Notice(
					`Knap Sync: skipped "${relativePath}". The relay version would ` +
						`have overwritten changes you made here. Merge them yourself ` +
						`and it syncs normally again.`,
					0,
				);
				return;
			}
		}

		// Download
		let content: ArrayBuffer;
		try {
			content = await this.clientManager.downloadFile(serverId, shareId, relativePath);
		} catch (err: unknown) {
			log("Failed to download file", {
				vaultPath,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		// Ensure parent directory exists
		const parentDir = normalizePath(dirname(vaultPath));
		if (parentDir && parentDir !== "." && parentDir !== "/") {
			try {
				await this.vault.adapter.mkdir(parentDir);
			} catch {
				// Directory may already exist
			}
		}

		// Write to vault with echo-loop guard
		this.writingPaths.add(vaultPath);
		try {
			await this.vault.adapter.writeBinary(vaultPath, content);
			shareManifest[relativePath] = serverSha256;
			log("Wrote sync-artifact to vault", { vaultPath, sha256: serverSha256 });
		} catch (err: unknown) {
			log("Failed to write file to vault", {
				vaultPath,
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.writingPaths.delete(vaultPath);
		}
	}

	destroy(): void {
		// Deliberately does NOT clear lastWrittenHash (TR-02, #307f52bf): when
		// backed by a persisted store, wiping it here on every plugin
		// unload/reload would defeat the entire point of persisting it. Only
		// transient in-flight-write tracking is reset.
		this.writingPaths.clear();
		log("InboundFileDownloader destroyed");
	}
}
