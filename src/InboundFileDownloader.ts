/**
 * Inbound File Downloader (v1.9)
 *
 * Fetches sync-artifact items from the server files index and writes them
 * to the local vault. Called by InboundSyncPoller when web_content_updated_at bumps.
 */

import { normalizePath, Notice, TFile, Vault } from "obsidian";
import { dirname, join } from "path-browserify";
import { curryLog } from "./debug";
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

	constructor(
		vault: Vault,
		clientManager: RelayOnPremShareClientManager,
		webSyncManager: WebSyncManager,
		hashManifestStore: Map<string, Record<string, string>> = new Map(),
	) {
		this.vault = vault;
		this.clientManager = clientManager;
		this.webSyncManager = webSyncManager;
		this.lastWrittenHash = hashManifestStore;
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

		// Resolve share path (cached by clientManager for 5 min)
		let sharePath: string;
		try {
			const share = await this.clientManager.getShare(serverId, shareId);
			sharePath = share.path;
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
			await this._downloadItem(item.path, item.sha256, shareId, serverId, sharePath, shareManifest);
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
	): Promise<void> {
		const vaultPath = normalizePath(join(sharePath, relativePath));

		// Guard against path traversal: the resolved vault path must stay inside sharePath.
		// A server-supplied relativePath like "../../.obsidian/plugins/evil.js" would resolve
		// outside the share directory after join+normalize — reject it before any I/O.
		const normalizedShare = normalizePath(sharePath);
		if (normalizedShare.length === 0) {
			// sharePath is server-supplied (share.path from clientManager.getShare()); an empty
			// value would otherwise disable the containment check entirely. Fail closed.
			log("Path traversal rejected: empty sharePath", { relativePath, shareId });
			return;
		}
		const withinShare =
			vaultPath === normalizedShare || vaultPath.startsWith(normalizedShare + "/");
		if (!withinShare) {
			log("Path traversal rejected", { relativePath, vaultPath, sharePath });
			return;
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
					`Team Relay: skipped syncing "${relativePath}" — local changes ` +
						`would have been overwritten by the relay version. Resolve ` +
						`manually, then it will sync normally.`,
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
