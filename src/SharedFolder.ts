"use strict";
import {
	App,
	FileManager,
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	debounce,
	normalizePath,
} from "obsidian";
import { IndexeddbPersistence } from "./storage/y-indexeddb";
import { dirname, sep } from "path-browserify";
import { buildConflictCopyPath } from "./conflictCopyPath";
import { HasProvider, type ConnectionIntent } from "./HasProvider";
import { Document } from "./Document";
import { ObservableSet } from "./observable/ObservableSet";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";

import { SharedPromise, Dependency, withTimeoutWarning } from "./promiseUtils";
import { S3Folder, S3RN, S3RemoteFolder } from "./S3RN";
import type { RemoteSharedFolder } from "./Relay";
import { RelayManager } from "./RelayManager";
import type { Unsubscriber } from "svelte/store";
import { DiskBufferStore } from "./DiskBuffer";
import { BackgroundSync } from "./BackgroundSync";
import type { NamespacedSettings } from "./SettingsStorage";
import { RelayInstances } from "./debug";
import { LocalStorage } from "./LocalStorage";
import { SyncFolder, isSyncFolder } from "./SyncFolder";
import { isDocument } from "./Document";
import {
	findByPath,
	hasUnsyncedEdit,
	hasUnsyncedCanvasEdit,
} from "./preserveBeforeTrash";
import { SyncStore } from "./SyncStore";
import {
	SyncType,
	makeCanvasMeta,
	makeDocumentMeta,
	makeFileMeta,
	makeFolderMeta,
	isSyncFileMeta,
	isCanvasMeta,
	type FileMeta,
	type Meta,
	type SyncFileType,
} from "./SyncTypes";
import type { IFile } from "./IFile";
import { createPathProxy } from "./pathProxy";
import { ContentAddressedStore } from "./CAS";
import { SyncSettingsManager, type SyncFlags } from "./SyncSettings";
import { ContentAddressedFileStore, SyncFile, isSyncFile } from "./SyncFile";
import { Canvas, isCanvas } from "./Canvas";
import { flags } from "./flagManager";
import { findNestingConflictPath } from "./sharedFolderNesting";
import {
	checkPath as scopedCheckPath,
	sharePrefix,
	toVaultPath,
	toVirtualPath,
	type ShareScope,
} from "./vaultScope";
import { claimVpathIfUnclaimed, awaitVpathClaimSettled, wonVpathClaim } from "./uploadClaim";
import { stampKnapMeta } from "./knapMeta";

export interface SharedFolderSettings {
	guid: string;
	path: string;
	/**
	 * Whether this share is the whole vault or one folder in it.
	 *
	 * Absent means "folder", so every share that predates this field keeps
	 * its meaning without a migration. A vault share carries path "".
	 */
	scope?: ShareScope;
	relay?: string;
	connect?: boolean;
	sync?: SyncFlags;
	/**
	 * Server ID for relay-onprem multi-server mode
	 * Indicates which server owns this share
	 */
	onpremServerId?: string;
}

interface Operation {
	op: "create" | "rename" | "delete" | "update" | "upgrade" | "noop";
	path: string;
	promise: Promise<void> | Promise<IFile>;
}

interface Create extends Operation {
	op: "create";
	path: string;
	promise: Promise<IFile>;
}

interface Rename extends Operation {
	op: "rename";
	path: string;
	from: string;
	to: string;
	promise: Promise<void>;
}

interface Delete extends Operation {
	op: "delete";
	path: string;
	promise: Promise<void>;
}

interface Update extends Operation {
	op: "update";
	path: string;
	promise: Promise<void>;
}

interface Upgrade extends Operation {
	op: "upgrade";
	path: string;
	promise: Promise<void>;
}

interface Noop extends Operation {
	op: "noop";
	path: string;
	promise: Promise<void>;
}

type OperationType = Create | Rename | Delete | Update | Upgrade | Noop;

class Files extends ObservableSet<IFile> {
	// Startup performance optimization: debounce to batch rapid file-tree updates
	notifyListeners = debounce(super.notifyListeners.bind(this), 100);

	update() {
		this.notifyListeners();
		return;
	}

	add(item: IFile, update = true): ObservableSet<IFile> {
		const existing = this.find((file) => file.guid === item.guid);
		if (existing && existing !== item) {
			this.error("duplicate guid", existing, item);
			this._set.delete(existing);
		}
		this._set.add(item);
		if (update) {
			this.notifyListeners();
		}
		return this;
	}
}

export class SharedFolder extends HasProvider {
	path: string;
	/** Whether this share covers the whole vault or one folder in it. */
	scope: ShareScope;
	files: Map<string, IFile>; // Maps guids to SharedDocs
	fset: Files;
	relayId?: string;
	_remote?: RemoteSharedFolder;
	_shouldConnect: boolean;
	destroyed: boolean = false;
	public vault: Vault;
	syncStore: SyncStore;
	private _server?: string;
	private fileManager: FileManager;
	private relayManager: RelayManager;
	private readyPromise: Dependency<SharedFolder> | null = null;
	private whenSyncedPromise: Dependency<void> | null = null;
	private persistenceSynced: boolean = false;
	private syncFileTreePromise: SharedPromise<void> | null = null;
	private syncRequestedDuringSync: boolean = false;
	private authoritative: boolean;
	private pendingUpload: LocalStorage<string>;
	private unsubscribes: Unsubscriber[] = [];
	private storageQuota?: number;
	private pendingDeletes: Set<string> = new Set();

	private _persistence: IndexeddbPersistence;
	diskBufferStore: DiskBufferStore;
	proxy: SharedFolder;
	cas: ContentAddressedStore;
	syncSettingsManager: SyncSettingsManager;

	constructor(
		public appId: string,
		guid: string,
		path: string,
		loginManager: LoginManager,
		vault: Vault,
		fileManager: FileManager,
		tokenStore: LiveTokenStore,
		relayManager: RelayManager,
		private hashStore: ContentAddressedFileStore,
		public backgroundSync: BackgroundSync,
		private _settings: NamespacedSettings<SharedFolderSettings>,
		private obsidianApp: App,
		relayId?: string,
		awaitingUpdates: boolean = true,
		scope: ShareScope = "folder",
	) {
		const s3rn = relayId
			? new S3RemoteFolder(relayId, guid)
			: new S3Folder(guid);

		super(guid, s3rn, tokenStore, loginManager);
		this.scope = scope;
		// A vault share has no folder prefix, so its path is empty whatever
		// the caller passed. Obsidian spells the vault root "/", and letting
		// that reach the prefix arithmetic is the off-by-one this avoids.
		this.path = scope === "vault" ? "" : path;
		this.setLoggers(
			scope === "vault" ? `[SharedVault]` : `[SharedFile](${this.path})`,
		);
		this.fileManager = fileManager;
		this.vault = vault;
		this.files = new Map();
		this.fset = new Files();
		this.pendingUpload = new LocalStorage<string>(
			`${appId}-synced-vaults/folders/${this.guid}/pendingUploads`,
			this.obsidianApp,
		);
		this.pendingUpload.forEach((guid, vpath) => {
			if (!this.existsSync(vpath)) {
				this.warn(
					"deleting pending upload record because file is missing",
					vpath,
					guid,
				);
				this.pendingUpload.delete(vpath);
			}
		});
		this.relayManager = relayManager;
		this.relayId = relayId;
		this.diskBufferStore = new DiskBufferStore();
		this._shouldConnect = this.settings.connect ?? true;

		this.authoritative = !awaitingUpdates;

		this.syncSettingsManager = this._settings.getChild<
			Record<keyof SyncFlags, boolean>,
			SyncSettingsManager
		>("sync", (settings, path) => new SyncSettingsManager(settings, path));

		this.syncStore = new SyncStore(
			this.ydoc,
			this.path,
			this.pendingUpload,
			this.syncSettingsManager,
		);
		this.syncStore.on(() => {
			void this.syncFileTree(this.syncStore);
		});

		this.unsubscribes.push(
			this.relayManager.remoteFolders.subscribe((folders) => {
				this.remote = folders.find((folder) => folder.guid == this.guid);
			}),
		);

		this.unsubscribes.push(
			this.relayManager.storageQuotas.subscribe((storageQuotas) => {
				void (async () => {
					const quota = storageQuotas.find((quota) => {
						return quota.id === this._remote?.relay.storageQuotaId;
					});
					if (quota === undefined) {
						return;
					}
					if (this.storageQuota !== quota.quota) {
						if (
							this.storageQuota !== undefined &&
							quota.quota !== undefined &&
							quota.quota > this.storageQuota
						) {
							this.debug(
								"storage quota increase",
								this.storageQuota,
								quota.quota,
							);
							await this.netSync();
						}
						this.debug("storage quota update", this.storageQuota, quota.quota);
						this.storageQuota = quota.quota;
					}
				})();
			}),
		);

		this.proxy = createPathProxy(this, this.path, (globalPath: string) => {
			return this.getVirtualPath(globalPath);
		});

		try {
			this._persistence = new IndexeddbPersistence(`synced-vaults-folder-${this.guid}`, this.ydoc);
		} catch (e: unknown) {
			this.warn("Unable to open persistence.", this.guid);
			console.error(e);
			throw e;
		}

		if (loginManager.loggedIn) {
			void this.connect();
		}

		this.cas = new ContentAddressedStore(this);

		void this.whenReady().then(async () => {
			if (!this.destroyed) {
				await this.whenSynced(); // Ensure IDB and syncStore.start() completed

				// Always wait for provider sync before processing files.
				// For the owner: ensures Y.Map writes propagate to the relay.
				// For the member: ensures we receive file metadata from the relay
				// (fixes stale serverSynced=true in IDB causing immediate resolve).
				if (this._shouldConnect) {
					try {
						await Promise.race([
							this.onceProviderSynced(),
							new Promise<void>((_, reject) =>
								window.setTimeout(() => reject(new Error("provider sync timeout")), 30000)
							)
						]);
					} catch (e: unknown) {
						console.warn(`[SharedFolder] ${this.path}: ${e instanceof Error ? e.message : String(e)}, proceeding with current state`);
					}
				}

				console.debug(`[SharedFolder] ready to sync: path=${this.path}, synced=${this.synced}, authoritative=${this.authoritative}`);
				await this.addLocalDocs();
				void this.syncFileTree(this.syncStore);
			}
		});


		void this.whenSynced().then(() => {
			this.syncStore.start();
			// Say what this share is, so Knap's page can call the row by the
			// vault's name instead of a hostname. After the sync rather than in
			// the constructor: the check against what is already there is only
			// meaningful once the remote document has arrived, and it is what
			// keeps this from being an update on every start.
			try {
				stampKnapMeta(this.ydoc, {
					scope: this.scope,
					vault: this.vault.getName(),
				});
			} catch (e) {
				this.warn("could not stamp share identity", e);
			}
			try {
				void this._persistence.set("path", this.path);
				void this._persistence.set("relay", this.relayId || "");
				void this._persistence.set("appId", this.appId);
				void this._persistence.set("s3rn", S3RN.encode(this.s3rn));
			} catch {
				// pass
			}
		});


		void (async () => {
			const serverSynced = await this.getServerSynced();
			if (!serverSynced) {
				await this.onceProviderSynced();
				await this.markSynced();
			}
		})();

		RelayInstances.set(this, this.path);
	}

	private addLocalDocs = async () => {
		const syncTFiles = this.getSyncFiles();
		const files: IFile[] = [];
		const newPaths = this.placeHold(syncTFiles);

		// Among the freshly-minted paths, Document/Canvas vpaths can race: two
		// clients discovering the SAME brand-new vpath at once (e.g. both
		// connecting to a brand-new shared folder that already has matching
		// local files) each minted a DIFFERENT guid above -- placeHold()'s
		// SyncStore.new() is a random uuidv4() into per-device LocalStorage,
		// never seen by the other client, before either publishes to the
		// shared meta map. Claim the vpath itself (there isn't a shared guid
		// to claim yet) so only the winner's guid actually gets
		// published/uploaded; the loser adopts the winner's guid instead of
		// publishing its own orphan (TR-15-follow-up, #7c14871a). Canvas
		// vpaths are excluded when canvas sync is disabled -- they fall
		// through to the generic syncFile path below, same as before, which
		// this claim doesn't cover.
		const raceable = newPaths.filter((vpath) => {
			if (Document.checkExtension(vpath)) return true;
			if (Canvas.checkExtension(vpath)) return flags().enableCanvasSync;
			return false;
		});
		const { lost } = await this.claimUploadPaths(raceable);
		const lostPaths = new Set(lost);

		// Ensure all local files have Y.Map metadata entries.
		// This is critical: markUploaded() only runs after background sync completes,
		// but if individual doc syncs hang (e.g., onceProviderSynced race condition),
		// the Y.Map never gets entries and the relay stays empty. Vpaths this
		// client lost the upload claim on are skipped here -- publishing their
		// locally-minted guid would race the winner's own publish on the same
		// key (see claimUploadPaths).
		this.ensureFileMetadata(syncTFiles, lostPaths);

		for (const tfile of syncTFiles) {
			const vpath = this.getVirtualPath(tfile.path);
			const upload = newPaths.contains(vpath) && !lostPaths.has(vpath);

			// Check if file already exists with correct type based on metadata
			const existingFile = this.getFile(tfile, false);
			if (existingFile) {
				files.push(existingFile);
				continue;
			}

			// For new files, use upload/create logic based on extension and feature flags
			if (tfile instanceof TFolder) {
				const doc = this.getSyncFolder(vpath, false);
				files.push(doc);
				continue;
			}
			if (Document.checkExtension(vpath)) {
				if (upload) {
					const doc = this.uploadDoc(vpath, false);
					files.push(doc);
				} else if (lostPaths.has(vpath)) {
					const doc = await this.adoptWinnerDoc(vpath);
					files.push(doc);
				} else {
					const doc = this.getDoc(vpath, false);
					files.push(doc);
				}
				continue;
			}
			if (Canvas.checkExtension(vpath)) {
				if (upload) {
					if (flags().enableCanvasSync) {
						const doc = this.uploadCanvas(vpath, false);
						files.push(doc);
						continue;
					}
					// fall through to syncFile
				} else if (lostPaths.has(vpath) && flags().enableCanvasSync) {
					const doc = await this.adoptWinnerCanvas(vpath);
					files.push(doc);
					continue;
				} else {
					const doc = this.getFile(tfile, false);
					if (doc) {
						files.push(doc);
						continue;
					}
				}
			}
			if (this.syncStore.canSync(vpath)) {
				if (upload) {
					const file = this.uploadSyncFile(vpath, false);
					files.push(file);
				} else {
					const file = this.syncFile(vpath, false);
					files.push(file);
				}
			}
		}
		if (files.length > 0) {
			this.fset.update();
		}
	};

	/**
	 * Runs the claim/settle/decide protocol (uploadClaim.ts) for each
	 * candidate vpath in parallel and returns which ones this client won vs.
	 * lost. A no-op (empty won/lost) for the common single-client case where
	 * `vpaths` is empty.
	 */
	private async claimUploadPaths(
		vpaths: string[],
	): Promise<{ won: string[]; lost: string[] }> {
		if (vpaths.length === 0) {
			return { won: [], lost: [] };
		}
		const results = await Promise.all(
			vpaths.map(async (vpath) => {
				claimVpathIfUnclaimed(this.ydoc, vpath, this._provider.awareness);
				await awaitVpathClaimSettled(this.ydoc, vpath, {
					socket: this._provider.ws,
				});
				return { vpath, won: wonVpathClaim(this.ydoc, vpath) };
			}),
		);
		return {
			won: results.filter((r) => r.won).map((r) => r.vpath),
			lost: results.filter((r) => !r.won).map((r) => r.vpath),
		};
	}

	/**
	 * Called for a Document vpath this client LOST the upload claim on --
	 * another client is (or will shortly be) canonical for it. Discards the
	 * guid this client would otherwise have minted for it (never published),
	 * waits for the winner's guid to sync in and its content to arrive
	 * (awaitDocSynced), then makes the winner's content canonical locally
	 * too.
	 *
	 * Winner-wins, not vault-file-wins (Bill's sign-off, 2026-07-26,
	 * reversing an earlier vault-file-wins draft of this method): the
	 * winner's content is ALREADY published to the relay and may already be
	 * visible to other peers, so overwriting it would propagate to
	 * everyone; a diverging loser's local content is still purely local, so
	 * archiving it stays confined to this one device. It's also
	 * deterministic with more than two racing clients -- with N losers,
	 * each makes exactly one local conflict-copy instead of a chain of
	 * canon-overwrites (one per loser, in arbitrary arrival order) that
	 * vault-file-wins would produce, re-opening the same class of race this
	 * whole fix chain exists to close (TR-15, #1c52a010).
	 *
	 * Never mutates doc.ydoc/the relay at all -- only the local vault file.
	 * This is what makes "every peer, including this loser, converges on
	 * the winner's content" true BY CONSTRUCTION rather than something a
	 * separate propagation step has to achieve: awaitDocSynced already
	 * waited for the winner's synced state before this method ever reads
	 * doc.text, so the canonical Y.Doc content is never touched, and the
	 * only write here is bringing the LOCAL FILE in line with it.
	 */
	private async adoptWinnerDoc(vpath: string): Promise<Document> {
		this.syncStore.clearPendingUpload(vpath);
		await this.awaitVpathResolved(vpath);

		const doc = this.getDoc(vpath, false);
		await this.awaitDocSynced(doc);

		let localContent: string;
		try {
			localContent = await this.read(doc);
		} catch (e: unknown) {
			this.warn(`Could not read ${vpath} to reconcile after losing the upload claim`, e);
			return doc;
		}

		const winnerContent = doc.text;
		if (!hasUnsyncedEdit(localContent, winnerContent)) {
			return doc;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		try {
			const conflictPath = await this.writeConflictCopy(
				doc,
				localContent,
				`upload race ${timestamp}`,
			);
			await this.flush(doc, winnerContent);
			this.log(
				`[${doc.path}] Lost the upload-claim race and had different local content -- ` +
					`adopted the winner's content, preserved ours at ${conflictPath}`,
			);
		} catch (e: unknown) {
			this.warn(
				`Failed to preserve local content for ${vpath} before adopting the upload-claim winner's content -- skipping to avoid silent data loss`,
				e,
			);
		}
		return doc;
	}

	/** Canvas equivalent of adoptWinnerDoc -- see its doc comment for the
	 * winner-wins rationale. Canvas content is JSON, not plain text, so the
	 * divergence check uses hasUnsyncedCanvasEdit (already the established
	 * comparison for this codebase's Canvas content, see
	 * preserveUnsyncedCanvasBeforeTrash) instead of hasUnsyncedEdit's plain
	 * string equality. */
	private async adoptWinnerCanvas(vpath: string): Promise<Canvas> {
		this.syncStore.clearPendingUpload(vpath);
		await this.awaitVpathResolved(vpath);

		const canvas = this.getCanvas(vpath, false);
		await this.awaitDocSynced(canvas);

		let localContent: string;
		try {
			localContent = await this.read(canvas);
		} catch (e: unknown) {
			this.warn(`Could not read ${vpath} to reconcile after losing the upload claim`, e);
			return canvas;
		}

		const syncedData = Canvas.exportCanvasData(canvas.ydoc);
		if (!hasUnsyncedCanvasEdit(localContent, syncedData)) {
			return canvas;
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		try {
			const conflictPath = await this.writeConflictCopy(
				canvas,
				localContent,
				`upload race ${timestamp}`,
			);
			await this.flush(canvas, canvas.json);
			this.log(
				`[${canvas.path}] Lost the upload-claim race and had different local content -- ` +
					`adopted the winner's content, preserved ours at ${conflictPath}`,
			);
		} catch (e: unknown) {
			this.warn(
				`Failed to preserve local content for ${vpath} before adopting the upload-claim winner's content -- skipping to avoid silent data loss`,
				e,
			);
		}
		return canvas;
	}

	/**
	 * Waits until `vpath` resolves in the synced meta map (the winner's
	 * publish has arrived) or `maxWaitMs` elapses. In the common case this
	 * returns almost immediately -- awaitVpathClaimSettled already waited out
	 * a quiet period on the SAME channel the winner's publish travels over.
	 * A timeout (winner crashed after claiming, before publishing) is not
	 * treated as fatal: the caller's subsequent getDoc()/getCanvas() call
	 * will itself mint a fresh guid via its own internal placeHold() if the
	 * vpath still isn't known, self-healing at the cost of bypassing this
	 * claim for that rare double-failure case.
	 */
	private async awaitVpathResolved(vpath: string, maxWaitMs = 5000): Promise<boolean> {
		const deadline = Date.now() + maxWaitMs;
		while (!this.syncStore.has(vpath) && Date.now() < deadline) {
			await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
		}
		return this.syncStore.has(vpath);
	}

	/**
	 * Waits for `doc`'s own websocket provider to report a real, authoritative
	 * synced state (bounded by `maxWaitMs`) before the caller trusts its
	 * content -- used by adoptWinnerDoc/adoptWinnerCanvas instead of
	 * BackgroundSync.enqueueDownload().
	 *
	 * Deliberately does NOT use enqueueDownload() here: its underlying
	 * getDocument() has a "server contains uninitialized doc" retry
	 * (BackgroundSync.ts) that reschedules itself via a DETACHED
	 * `timeProvider.setTimeout`, never chained into the promise
	 * enqueueDownload returns -- so that promise resolves while doc.ydoc is
	 * still empty, exactly in the timing window this method is called in
	 * (right after the upload-claim settles, when the winner's own publish
	 * may not have landed on the relay yet). Reconciling against
	 * still-empty content would write a conflict-copy that doesn't actually
	 * capture the winner's content, then apply this device's local content
	 * on top -- and when the real winner content arrives moments later via
	 * ordinary sync, Yjs merges it against this device's already-applied
	 * diff-patch ops as two independent edit histories, reintroducing the
	 * exact interleaved/duplicated-text failure this whole fix chain exists
	 * to prevent (TR-15, #1c52a010), just in a narrower timing window.
	 *
	 * `onceProviderSynced()` is the websocket-based signal SharedFolder's
	 * own constructor and BackgroundSync.syncDocumentWebsocket already rely
	 * on for the same "wait for real synced state" need, and doesn't share
	 * that gap -- it resolves off the live provider connection, not a
	 * one-shot HTTP download with a detached retry.
	 */
	private async awaitDocSynced(doc: Document | Canvas, maxWaitMs = 30000): Promise<void> {
		const synced = doc.onceProviderSynced();
		const connected = await doc.connect();
		if (!connected) {
			this.warn(
				`Connect failed for ${doc.path} while adopting the upload-claim winner's content`,
			);
			return;
		}
		await Promise.race([
			synced,
			new Promise<void>((resolve) => window.setTimeout(resolve, maxWaitMs)),
		]);
	}

	/**
	 * Ensure all local files have Y.Map metadata entries (filemeta_v0).
	 * Without this, the relay has no file metadata and other devices
	 * can't see the file list.
	 *
	 * `skip` excludes vpaths this client lost the upload-claim race on
	 * (TR-15-follow-up, #7c14871a) -- their locally-minted guid must never be
	 * published, since the winner is publishing their own guid for the same
	 * vpath and both writing to `meta` would silently re-introduce the exact
	 * divergent-guid race this method's caller (addLocalDocs) claims against.
	 */
	private ensureFileMetadata(syncTFiles: TAbstractFile[], skip?: Set<string>) {
		let written = 0;
		this.ydoc.transact(() => {
			syncTFiles.forEach((file) => {
				if (file instanceof TFolder) return;
				const vpath = this.getVirtualPath(file.path);
				if (skip?.has(vpath)) return;
				const guid = this.syncStore.get(vpath);
				if (!guid) return;

				// Skip if Y.Map already has this entry
				if (this.syncStore.hasYMapEntry(vpath)) return;

				// Write metadata based on file type
				if (Document.checkExtension(vpath)) {
					this.syncStore.ensureMeta(vpath, makeDocumentMeta(guid));
					written++;
				} else if (Canvas.checkExtension(vpath)) {
					this.syncStore.ensureMeta(vpath, makeCanvasMeta(guid));
					written++;
				}
				// SyncFile types need hash/mimetype - they'll be written by markUploaded()
			});
		}, this);
		if (written > 0) {
			console.debug(`[SharedFolder] ensureFileMetadata: wrote ${written} Y.Map entries for ${this.path}`);
		}
	}

	public get server(): string | undefined {
		return this._server;
	}

	public set server(value: string | undefined) {
		if (value === this._server) {
			return;
		}
		this.warn("server changed -- reinitializing all connections");
		const shouldConnect = this.shouldConnect;
		this.reset();
		const reconnect: HasProvider[] = [];
		this.fset.forEach((file) => {
			if (file instanceof HasProvider) {
				if (file.connected) {
					reconnect.push(file);
				}
				file.reset();
			}
		});
		this.tokenStore.clear((token) => {
			return token.token?.folder === this.guid;
		});
		if (shouldConnect) {
			void this.connect();
			reconnect.forEach((file) => {
				void file.connect();
			});
		}
		this._server = value;
	}

	/**
	 * The folder this share is rooted at.
	 *
	 * Resolved through `getRoot()` for a vault share rather than by looking
	 * up the path, because how `getAbstractFileByPath` spells the vault root
	 * is not something the API guarantees.
	 */
	private get rootTFolder(): TFolder {
		if (this.isVaultScope) {
			return this.vault.getRoot();
		}
		const folder = this.vault.getAbstractFileByPath(this.path);
		if (!(folder instanceof TFolder)) {
			throw new Error("tfolder is not a folder");
		}
		return folder;
	}

	public get tfolder(): TFolder {
		return this.rootTFolder;
	}

	public isSyncableTFile(tfile: TAbstractFile): boolean {
		const inFolder = this.checkPath(tfile.path);
		// Return before converting. checkPath now refuses excluded paths as
		// well as paths outside the share, and getVirtualPath throws on
		// anything checkPath refused. At vault scope the walk starts at the
		// root, so refused paths really do arrive here.
		if (!inFolder) {
			return false;
		}
		const vpath = this.getVirtualPath(tfile.path);
		const isSupportedFileType = this.syncStore.canSync(vpath);

		// For folders, we only need to check if the sync store supports them
		// Extension preferences don't apply to folders
		if (tfile instanceof TFolder) {
			return inFolder && isSupportedFileType;
		}

		const isExtensionEnabled =
			this.syncSettingsManager.isExtensionEnabled(vpath);

		return inFolder && isSupportedFileType && isExtensionEnabled;
	}

	private getSyncFiles(): TAbstractFile[] {
		const folder = this.rootTFolder;
		const files: TAbstractFile[] = [];
		Vault.recurseChildren(folder, (file: TAbstractFile) => {
			if (file !== folder) {
				files.push(file);
			}
		});
		return files.filter((tfile) => {
			return this.isSyncableTFile(tfile);
		});
	}

	public get shouldConnect(): boolean {
		return this._shouldConnect;
	}

	public set shouldConnect(connect: boolean) {
		void this._settings.update((current) => ({
			...current,
			connect,
		}));
		this._shouldConnect = connect;
	}

	async netSync() {
		await this.whenReady();
		// Wait for provider to fully sync remote state before reconciling.
		// Without this, cleanupExtraLocalFiles may see incomplete remote state
		// and delete files that exist on the server but haven't been received yet.
		await this.onceProviderSynced();
		// addLocalDocs is async and claims against the divergent-guid race, so
		// syncFileTree must not start until it has finished. The other caller
		// (whenReady) awaits it for the same reason.
		await this.addLocalDocs();
		await this.syncFileTree(this.syncStore);
		this.backgroundSync.enqueueSharedFolderSync(this);
	}

	public get settings(): SharedFolderSettings {
		return this._settings.get();
	}

	async sync() {
		await this.syncFileTree(this.syncStore);
	}

	connect(): Promise<boolean> {
		if (this.s3rn instanceof S3RemoteFolder) {
			if (this.connected || this.shouldConnect) {
				return super.connect();
			}
		}
		return Promise.resolve(false);
	}

	public get name(): string {
		// A vault share has no folder to take a name from, and an empty name
		// is what the control plane would store for the share.
		if (this.isVaultScope) {
			return this.vault.getName();
		}
		return this.path.split("/").pop() || "";
	}

	public get location(): string {
		if (this.isVaultScope) {
			return "";
		}
		return this.path.split("/").slice(0, -1).join("/");
	}

	public get remote(): RemoteSharedFolder | undefined {
		try {
			// FIXME: race condition because sharedFolder doesn't use postie
			// for notifyListener updates.
			void this._remote?.relay;
		} catch {
			return undefined;
		}
		return this._remote;
	}

	public set remote(value: RemoteSharedFolder | undefined) {
		if (this._remote === value) {
			return;
		}
		this._remote = value;
		this.relayId = value?.relay?.guid;
		this.s3rn = this.relayId
			? new S3RemoteFolder(this.relayId, this.guid)
			: new S3Folder(this.guid);
		void this._settings.update((current) => ({
			...current,
			...{ relay: this.relayId },
		}));

		if (value) {
			this._server = value.relay.providerId;
			this.unsubscribes.push(
				value.relay.subscribe((relay) => {
					if (relay.guid === this.relayId) {
						this.server = relay.providerId;
					}
				}),
			);
		}

		this.server = value?.relay.providerId;
		this.notifyListeners();
	}

	public get ready(): boolean {
		return (
			this.persistenceSynced &&
			(this.authoritative || this._persistence.hasServerSync || this.synced)
		);
	}


	async markSynced(): Promise<void> {
		await this._persistence.markServerSynced();
	}

	async getServerSynced(): Promise<boolean> {
		return this._persistence.getServerSynced();
	}

	private hasLocalDB(): boolean {
		return this._persistence.hasUserData();
	}

	async awaitingUpdates(): Promise<boolean> {
		await this.whenSynced();
		const hasLocal = this.hasLocalDB();
		const serverSynced = await this.getServerSynced();
		console.debug(`[SharedFolder] awaitingUpdates: authoritative=${this.authoritative}, serverSynced=${serverSynced}, hasLocalDB=${hasLocal}, path=${this.path}`);
		if (this.authoritative) {
			return false;
		}
		if (serverSynced) {
			return false;
		}
		return !hasLocal;
	}

	whenReady(): Promise<SharedFolder> {
		const promiseFn = async (): Promise<SharedFolder> => {
			const awaitingUpdates = await this.awaitingUpdates();
			console.debug(`[SharedFolder] whenReady: awaitingUpdates=${awaitingUpdates}, path=${this.path}, authoritative=${this.authoritative}`);
			if (awaitingUpdates) {
				// If this is a brand new shared folder, we want to wait for a connection before we start reserving new guids for local files.
				void this.connect();

				// Timeout after 30s to prevent silent hangs
				const timeout = new Promise<never>((_, reject) =>
					window.setTimeout(() => reject(new Error("whenReady timeout: server sync took too long")), 30000)
				);

				try {
					await Promise.race([
						(async () => {
							await this.onceConnected();
							console.debug(`[SharedFolder] whenReady: onceConnected resolved`);
							await this.onceProviderSynced();
							console.debug(`[SharedFolder] whenReady: onceProviderSynced resolved`);
						})(),
						timeout
					]);
				} catch (e: unknown) {
					console.warn(`[SharedFolder] whenReady: ${e instanceof Error ? e.message : String(e)}`);
					// Fall through — allow syncFileTree to run with whatever state we have
				}

				return this;
			}
			// If this is a shared folder with edits, then we can behave as though we're just offline.
			console.debug(`[SharedFolder] whenReady: NOT awaiting updates, resolving immediately`);
			return this;
		};
		this.readyPromise =
			this.readyPromise ||
			new Dependency<SharedFolder>(promiseFn, (): [boolean, SharedFolder] => {
				return [this.ready, this];
			});
		return this.readyPromise.getPromise();
	}

	whenSynced(): Promise<void> {
		const promiseFn = async (): Promise<void> => {
			// Check if already synced first
			if (this._persistence.synced) {
				this.persistenceSynced = true;
				return;
			}

			return new Promise<void>((resolve) => {
				this._persistence.once("synced", () => {
					this.persistenceSynced = true;
					resolve();
				});
			});
		};

		this.whenSyncedPromise =
			this.whenSyncedPromise ||
			new Dependency<void>(promiseFn, (): [boolean, void] => {
				if (this._persistence.synced) {
					this.persistenceSynced = true;
				}
				return [this.persistenceSynced, undefined];
			});
		return this.whenSyncedPromise.getPromise();
	}

	public get intent(): ConnectionIntent {
		return this.shouldConnect ? "connected" : "disconnected";
	}

	async _handleServerRename(
		doc: IFile,
		path: string,
		file: TAbstractFile,
		diffLog?: string[],
	): Promise<void> {
		// take a doc and it's new path.
		diffLog?.push(`${file.path} was renamed to ${this.getPath(path)}`);
		if (file instanceof TFile) {
			const dir = dirname(path);
			if (!this.existsSync(dir)) {
				await this.mkdir(dir);
				diffLog?.push(`creating directory ${dir}`);
			}
		}
		await this.fileManager
			.renameFile(file, normalizePath(this.getPath(path)))
			.then(() => {
				doc.move(path, this);
			});
	}

	async _handleServerCreate(
		vpath: string,
		meta: Meta,
		diffLog?: string[],
	): Promise<IFile> {
		console.debug(`[SharedFolder] _handleServerCreate: vpath=${vpath}, type=${meta.type}, id=${meta.id?.slice(0,8)}`);
		// Create directories as needed
		const dir = dirname(vpath);
		if (!this.existsSync(dir)) {
			await this.mkdir(dir);
			diffLog?.push(`creating directory ${dir}`);
		}
		if (meta.type === SyncType.Document) {
			diffLog?.push(`created local .md file for remotely added doc ${vpath}`);
			const doc = this.downloadDoc(vpath, false);
			return doc;
		}
		if (meta.type === SyncType.Canvas) {
			diffLog?.push(
				`created local .canvas file for remotely added canvas ${vpath}`,
			);
			const canvas = this.downloadCanvas(vpath, false);
			return canvas;
		}
		if (meta.type === SyncType.Folder) {
			diffLog?.push(`created local folder for remotely added folder ${vpath}`);
			return this.getSyncFolder(vpath, false);
		}
		if (this.syncStore.canSync(vpath)) {
			diffLog?.push(`created local file for remotely added file ${vpath}`);
			return this.downloadSyncFile(vpath, false);
		}
		throw new Error(
			`${vpath}: Unexpected file type ${meta.type} ${meta.mimetype}`,
		);
	}

	private _assertNamespacing(path: string) {
		// Check if the path is valid (inside of shared folder), otherwise delete
		try {
			this.assertPath(this.getPath(path));
		} catch {
			this.error("Deleting doc (somehow moved outside of shared folder)", path);
			this.syncStore.delete(path);
			return;
		}
	}

	private applyRemoteState(
		guid: string,
		path: string,
		remoteIds: Set<string>,
		diffLog: string[],
	): OperationType {
		// Skip files that are being locally deleted — prevents race condition
		// where syncFileTree runs between disk deletion and syncStore removal
		if (this.isPendingDelete(path)) {
			return { op: "noop", path, promise: Promise.resolve() };
		}

		const file = this.files.get(guid);
		const meta = this.syncStore.getMeta(path);
		if (!meta) {
			this.warn("unknown sync type", path);
			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (this.existsSync(path)) {
			// Check for type mismatch: local SyncFile vs remote Canvas
			if (file && isSyncFile(file) && isCanvasMeta(meta)) {
				// Upgrade SyncFile to Canvas type
				const promise = this._upgradeToCanvas(file, guid, path, diffLog);
				return { op: "upgrade", path, promise };
			}

			// XXX file meta typing
			if (file && isSyncFile(file) && file.shouldPull(meta as FileMeta)) {
				return { op: "update", path, promise: file.pull() };
			}

			// Check for GUID mismatch - file exists but not mapped to remote GUID
			if (!file && isSyncFileMeta(meta)) {
				const localGuid = this.syncStore.get(path);
				const localFile = localGuid ? this.files.get(localGuid) : null;

				if (localGuid && localFile && isSyncFile(localFile)) {
					// We have a local file with different GUID - check if content matches
					const promise = this.remapIfHashMatches(
						localFile,
						localGuid,
						guid,
						path,
						meta,
					);
					return { op: "update", path, promise };
				}
			}

			return { op: "noop", path, promise: Promise.resolve() };
		}

		if (remoteIds.has(guid) && file) {
			const oldPath = this.getPath(file.path);
			const tfile = this.vault.getAbstractFileByPath(oldPath);
			if (tfile) {
				const promise = this._handleServerRename(file, path, tfile, diffLog);
				return {
					op: "rename",
					path: path,
					from: oldPath,
					to: path,
					promise,
				};
			}
		}

		// write will trigger `create` which will read the file from disk by default.
		// so we need to pre-empt that by loading the file into docs.
		const promise = this._handleServerCreate(path, meta, diffLog);
		return { op: "create", path, promise };
	}

	private async remapIfHashMatches(
		localFile: SyncFile,
		localGuid: string,
		remoteGuid: string,
		path: string,
		remoteMeta: Meta,
	): Promise<void> {
		try {
			const localHash = await localFile.caf.hash();
			if (localHash === remoteMeta.hash) {
				// Same content! Remap to use remote GUID
				this.files.delete(localGuid);
				this.pendingUpload.delete(path);
				this.files.set(remoteGuid, localFile);
				localFile.guid = remoteGuid;
				this.log(
					`Remapped file ${path} from local GUID ${localGuid} to remote GUID ${remoteGuid}`,
				);
			}
		} catch (error: unknown) {
			this.error("Error during GUID remapping:", error);
			throw error;
		}
	}

	private _upgradeToCanvas(
		syncFile: SyncFile,
		remoteGuid: string,
		path: string,
		diffLog?: string[],
	): Promise<void> {
		try {
			// Remove the old SyncFile
			const localGuid = syncFile.guid;
			this.files.delete(localGuid);
			this.fset.delete(syncFile);
			syncFile.destroy();

			diffLog?.push(`Upgrading ${path} from SyncFile to Canvas`);
			this.log(
				`Upgrading ${path} from SyncFile to Canvas (GUID: ${localGuid} → ${remoteGuid})`,
			);

			// downloadCanvas will handle adding to files and fset
			this.downloadCanvas(path, false);
			this.log(`Successfully upgraded ${path} to Canvas`);
			return Promise.resolve();
		} catch (error: unknown) {
			this.error("Error during SyncFile to Canvas upgrade:", error);
			throw error;
		}
	}

	private cleanupExtraLocalFiles(
		remotePaths: string[],
		diffLog: string[],
	): Delete[] {
		// Build the FULL set of known remote paths from the syncStore.
		// This is safer than using the ops-based remotePaths which only contains
		// paths that had operations, and may be incomplete during partial sync.
		const allRemotePaths = new Set<string>(remotePaths);
		this.syncStore.forEach((meta, path) => {
			allRemotePaths.add(path);
		});

		// Safety: if remote state is empty, this is likely a first sync —
		// do NOT delete local files (they should be uploaded to remote instead)
		if (allRemotePaths.size === 0) {
			return [];
		}

		// Additional safety: require provider+persistence to be synced
		const synced = this._provider?.synced && this._persistence?.synced;
		if (!synced) {
			this.log("cleanupExtraLocalFiles: skipping — provider/persistence not synced");
			return [];
		}

		// Delete files that are no longer shared
		const ffiles = this.getSyncFiles();
		const deletes: Delete[] = [];
		const folders = ffiles.filter((file) => file instanceof TFolder);
		const files = ffiles.filter((file) => file instanceof TFile);
		const sync = (file: TAbstractFile) => {
			const isSyncableFile = this.isSyncableTFile(file);
			const fileInFolder = this.checkPath(file.path);
			const vpath = this.getVirtualPath(file.path);
			const fileInMap = allRemotePaths.has(vpath);
			const filePending = this.pendingUpload.has(vpath);
			if (fileInFolder && isSyncableFile && !fileInMap && !filePending) {
				diffLog.push(`deleted local file ${vpath} for remotely deleted doc`);
				// A remote delete races with an offline local edit the same way
				// TR-01's reconcile did — the difference is this path destroys
				// the file outright instead of overwriting it. Preserve any
				// unsynced edit as a conflict-copy first (TR-42, #121a9874);
				// folders have no content of their own to preserve. Fail
				// CLOSED like TR-01's reconcileWithConflictCopy: if we can't
				// positively confirm it's safe (nothing to preserve, or the
				// preserve step actually succeeded), skip the trash this
				// cycle rather than risk destroying an edit we couldn't check.
				const promise = (
					file instanceof TFile
						? Canvas.checkExtension(vpath)
							? this.preserveUnsyncedCanvasBeforeTrash(vpath)
							: this.preserveUnsyncedDocumentBeforeTrash(vpath)
						: Promise.resolve(true)
				).then((safeToTrash) => {
					if (!safeToTrash) {
						diffLog.push(
							`skipped trashing ${vpath} — could not confirm no unsynced edits`,
						);
						return;
					}
					return this.vault.adapter.trashLocal(file.path);
				});
				deletes.push({
					op: "delete",
					path: vpath,
					promise,
				});
			}
		};
		files.forEach(sync);
		folders.forEach(sync);
		return deletes;
	}

	/**
	 * Before a remote-delete cleanup trashes a local file, check whether it
	 * has unsynced edits and preserve them as a conflict-copy instead of
	 * letting `trashLocal` silently discard them (TR-42, #121a9874).
	 *
	 * By the time cleanupExtraLocalFiles runs, the remote deletion has
	 * already removed this path's syncStore entry (a CRDT map removal),
	 * so there's no "last known synced hash" left to compare against for
	 * that path. The one thing that CAN still hold the last-synced content
	 * is a live Document object in `this.files` — nothing clears it in
	 * response to a remote delete, so for a Document whose session hasn't
	 * restarted since it was last synced, `doc.text` still reflects that
	 * state. Comparing the on-disk file against it is the same technique
	 * TR-01's reconcileWithConflictCopy uses, applied to the delete path.
	 *
	 * Returns whether it's safe to proceed with the trash. Fails CLOSED,
	 * matching TR-01's reconcileWithConflictCopy: any step we can't
	 * positively confirm (couldn't read the file, couldn't write the
	 * conflict-copy) returns false rather than falling through to trash —
	 * an orphaned local file left behind for the next cleanup pass to
	 * retry is strictly safer than destroying content we couldn't verify.
	 *
	 * Known gaps (not fixed here, scoped out for this P3 fix):
	 * - If the app restarted between the last sync and the remote delete,
	 *   `this.files` has no entry for this path — nothing left to safely
	 *   compare against, so this falls back to the existing trash behavior.
	 * - `this.files` is keyed by GUID and never pruned on a remote delete,
	 *   so a path that's been deleted-then-recreated more than once in the
	 *   same session could have more than one entry matching `vpath`.
	 *   `findByPath` returns the LAST match by iteration order (Map
	 *   iteration = insertion order), which is the most-recently-created —
	 *   i.e. the live one — but an old orphaned entry at the same path is
	 *   still possible in principle; this doesn't attempt to prune it.
	 *
	 * See `preserveUnsyncedCanvasBeforeTrash` below for the Canvas
	 * equivalent — same shape and same gaps, different content format.
	 */
	private async preserveUnsyncedDocumentBeforeTrash(
		vpath: string,
	): Promise<boolean> {
		const doc = findByPath(this.files.values(), vpath, isDocument) as
			| Document
			| undefined;
		if (!doc) {
			return true;
		}

		let onDiskContent: string;
		try {
			onDiskContent = await this.read(doc);
		} catch (e: unknown) {
			this.warn(`Could not read ${vpath} before trashing`, e);
			return false;
		}

		if (!hasUnsyncedEdit(onDiskContent, doc.text)) {
			return true; // matches the last known synced content — nothing to preserve
		}

		try {
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const conflictPath = await this.writeConflictCopy(
				doc,
				onDiskContent,
				`relay deleted ${timestamp}`,
			);
			this.log(
				`Preserved unsynced edits to ${vpath} at ${conflictPath} before remote-delete cleanup`,
			);
			return true;
		} catch (e: unknown) {
			this.warn(`Failed to write conflict copy for ${vpath} before trashing`, e);
			return false;
		}
	}

	/**
	 * Canvas equivalent of `preserveUnsyncedDocumentBeforeTrash` (audit
	 * #96d804dd, follow-up to TR-42 #121a9874). Same underlying constraint:
	 * by the time cleanupExtraLocalFiles runs, the remote delete has already
	 * removed this path's syncStore entry, so the only remaining anchor for
	 * "last known synced state" is the live `Canvas` object in `this.files`
	 * — there is no last-synced snapshot to fall back to.
	 *
	 * Unlike a Document, a `.canvas` file is JSON rather than plain text, so
	 * this compares parsed structures via `hasUnsyncedCanvasEdit` (deep
	 * object comparison) instead of raw string equality — matching the
	 * existing precedent in BackgroundSync.syncDocumentWebsocket, which
	 * uses the same `areObjectsEqual`-based comparison for canvas content
	 * for the same reason (on-disk JSON is pretty-printed; the exported Y.Doc
	 * state isn't, so string comparison would false-positive on every file).
	 *
	 * Same fail-closed contract and known gaps as the Document version.
	 */
	private async preserveUnsyncedCanvasBeforeTrash(
		vpath: string,
	): Promise<boolean> {
		const canvas = findByPath(this.files.values(), vpath, isCanvas) as
			| Canvas
			| undefined;
		if (!canvas) {
			return true;
		}

		let onDiskContent: string;
		try {
			onDiskContent = await this.read(canvas);
		} catch (e: unknown) {
			this.warn(`Could not read ${vpath} before trashing`, e);
			return false;
		}

		const syncedData = Canvas.exportCanvasData(canvas.ydoc);
		if (!hasUnsyncedCanvasEdit(onDiskContent, syncedData)) {
			return true; // matches the last known synced content — nothing to preserve
		}

		try {
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const conflictPath = await this.writeConflictCopy(
				canvas,
				onDiskContent,
				`relay deleted ${timestamp}`,
			);
			this.log(
				`Preserved unsynced edits to ${vpath} at ${conflictPath} before remote-delete cleanup`,
			);
			return true;
		} catch (e: unknown) {
			this.warn(`Failed to write conflict copy for ${vpath} before trashing`, e);
			return false;
		}
	}

	syncByType(
		syncStore: SyncStore,
		diffLog: string[],
		ops: Operation[],
		types: SyncType[],
	) {
		syncStore.forEach((meta, path) => {
			this._assertNamespacing(path);
			if (types.contains(meta.type)) {
				this._assertNamespacing(path);
				ops.push(
					this.applyRemoteState(meta.id, path, syncStore.remoteIds, diffLog),
				);
			}
		});
	}

	syncFileTree(syncStore: SyncStore): Promise<void> {
		// If a sync is already running, mark that we want another sync after
		if (this.syncFileTreePromise) {
			this.syncRequestedDuringSync = true;
			const promise = this.syncFileTreePromise.getPromise();
			void promise.then(() => {
				if (this.syncRequestedDuringSync) {
					this.syncRequestedDuringSync = false;
					return this.syncFileTree(syncStore);
				}
			});
			return promise;
		}

		const promiseFn = async (): Promise<void> => {
			try {
				const ops: Operation[] = [];
				const diffLog: string[] = [];

				// Debug: log Y.Map state before sync
				const metaEntries: string[] = [];
				syncStore.forEach((meta, path) => metaEntries.push(`${path}(${meta.type}:${meta.id?.slice(0,8)})`));
				const legacyEntries: string[] = [];
				try { (this.syncStore as unknown as Record<string, { forEach?: (cb: (guid: string, path: string) => void) => void }>).legacyIds?.forEach?.((guid: string, path: string) => legacyEntries.push(`${path}=${guid?.slice(0,8)}`)); } catch { /* ignore */ }
				console.debug(`[SharedFolder] syncFileTree START: meta=${metaEntries.length}, legacy=${legacyEntries.length}, path=${this.path}`);
				if (metaEntries.length > 0) console.debug(`[SharedFolder] syncFileTree meta entries:`, metaEntries.slice(0, 20));
				if (legacyEntries.length > 0) console.debug(`[SharedFolder] syncFileTree legacy entries:`, legacyEntries.slice(0, 20));

				void this.ydoc.transact(() => {
					// Sync folder operations first because renames/moves also affect files
					this.syncStore.migrateUp();
					this.syncByType(syncStore, diffLog, ops, [SyncType.Folder]);
				}, this);
				await Promise.all(ops.map((op) => op.promise));
				void this.ydoc.transact(() => {
					this.syncByType(
						syncStore,
						diffLog,
						ops,
						this.syncStore.typeRegistry.getEnabledFileSyncTypes(),
					);
					this.syncStore.commit();
				}, this);

				const creates = ops.filter((op) => op.op === "create");
				const renames = ops.filter((op) => op.op === "rename");
				const remotePaths = ops.map((op) => op.path);

				// Ensure these complete before checking for deletions
				await Promise.all(
					[...creates, ...renames].map((op) =>
						withTimeoutWarning<IFile | void>(op.promise, op),
					),
				);

				const deletes = this.cleanupExtraLocalFiles(remotePaths, diffLog);
				if ([...ops, ...deletes].every((op) => op.op === "noop")) {
					this.debug("sync: noop");
				} else {
					this.log("remote paths", remotePaths);
					this.log("operations", [...ops, ...deletes]);
				}
				if (renames.length > 0 || creates.length > 0 || deletes.length > 0) {
					this.fset.update();
				}
				if (diffLog.length > 0) {
					this.log("syncFileTree diff:\n" + diffLog.join("\n"));
				}
			} finally {
				// Reset the promise after completion (success or failure)
				this.syncFileTreePromise = null;
			}
		};

		this.syncFileTreePromise = new SharedPromise<void>(promiseFn);

		return this.syncFileTreePromise.getPromise();
	}

	move(path: string) {
		// A vault share is not rooted at a folder, so there is nothing to
		// move it to. Renaming the vault does not change the share.
		if (this.isVaultScope) {
			return;
		}
		this.path = path;
		this.setLoggers(`[SharedFile](${this.path})`);
		void this._settings.update((current) => ({
			...current,
			path,
		}));
	}

	/**
	 * Refuse a virtual path that would write outside what this share may touch.
	 *
	 * Every inbound write resolves a vpath that came off the CRDT, and the
	 * write goes through `vault.adapter`, which is raw filesystem access and
	 * not the file index. A folder share was protected by its own prefix; a
	 * vault share has no prefix, so a vpath of `.obsidian/plugins/x/main.js`
	 * or `../outside.md` would otherwise land on disk. This is the one guard
	 * standing between a remote document and somebody's config directory.
	 */
	private assertWritableVPath(vpath: string): void {
		const vaultPath = this.getPath(vpath);
		if (!this.checkPath(vaultPath)) {
			throw new Error(`Refusing to write outside the share: ${vpath}`);
		}
	}

	read(doc: IFile): Promise<string> {
		const vaultPath = this.getPath(doc.path);
		return this.vault.adapter.read(normalizePath(vaultPath));
	}

	existsSync(path: string): boolean {
		const vaultPath = normalizePath(this.getPath(path));
		const pathExists = this.vault.getAbstractFileByPath(vaultPath) !== null;
		return pathExists;
	}

	exists(doc: IFile): Promise<boolean> {
		const vaultPath = this.getPath(doc.path);
		return this.vault.adapter.exists(normalizePath(vaultPath));
	}

	flush(doc: IFile, content: string): Promise<void> {
		if (this.isPendingDelete(doc.path)) {
			this.log("skipping flush for pending delete", doc.path);
			return Promise.resolve();
		}
		this.assertWritableVPath(doc.path);
		const vaultPath = this.getPath(doc.path);
		this.log("writing to ", normalizePath(vaultPath));
		return this.vault.adapter.write(normalizePath(vaultPath), content);
	}

	/**
	 * Write `content` to a new file next to `doc.path`, never overwriting the
	 * original. Used to preserve content that a reconciliation is about to
	 * discard (TR-01, #814d6d9b) so nothing is silently lost — the file is
	 * left for the user to inspect/merge manually.
	 *
	 * Returns the doc-relative path (same shape as `doc.path`) it wrote to.
	 */
	async writeConflictCopy(
		doc: IFile,
		content: string,
		label: string,
	): Promise<string> {
		const conflictDocPath = buildConflictCopyPath(doc.path, label);
		this.assertWritableVPath(conflictDocPath);
		const vaultPath = this.getPath(conflictDocPath);
		await this.vault.adapter.write(normalizePath(vaultPath), content);
		return conflictDocPath;
	}

	/** True when this share is the whole vault rather than one folder in it. */
	public get isVaultScope(): boolean {
		return this.scope === "vault";
	}

	/**
	 * What every vault path in this share begins with.
	 *
	 * "Folder/" for a folder share, "" for a vault share. Every path
	 * conversion below is this string and nothing else, which is what lets
	 * the two scopes share one implementation.
	 */
	private get prefix(): string {
		return sharePrefix(this.scope, this.path, sep);
	}

	getPath(path: string): string {
		return toVaultPath(this.scope, this.path, path, sep);
	}

	assertPath(path: string) {
		if (!this.checkPath(path)) {
			throw new Error("Path is not in shared folder: " + path);
		}
	}

	mkdir(path: string): Promise<void> {
		this.assertWritableVPath(path);
		const vaultPath = this.getPath(path);
		return this.vault.adapter.mkdir(normalizePath(vaultPath));
	}

	/**
	 * Write an attachment's bytes, through the same guard as everything else.
	 *
	 * SyncFile used to reach `vault.adapter.writeBinary` itself with a vpath
	 * that came off the CRDT. On a folder share the prefix made that harmless.
	 * On a vault share it is the hole this class exists to close, so the write
	 * comes back here rather than staying there.
	 */
	writeBinary(path: string, content: ArrayBuffer): Promise<void> {
		this.assertWritableVPath(path);
		const vaultPath = this.getPath(path);
		return this.vault.adapter.writeBinary(normalizePath(vaultPath), content);
	}

	checkPath(path: string): boolean {
		return scopedCheckPath(
			this.scope,
			this.path,
			path,
			sep,
			this.obsidianApp?.vault?.configDir,
		);
	}

	getVirtualPath(path: string): string {
		this.assertPath(path);
		return toVirtualPath(this.scope, this.path, path, sep);
	}

	getTFile(file: IFile): TFile | null {
		const maybeTFile = this.vault.getAbstractFileByPath(
			this.getPath(file.path),
		);
		if (maybeTFile instanceof TFile) {
			return maybeTFile;
		}
		return null;
	}

	public getDoc(vpath: string, update = true): Document {
		const id = this.syncStore.get(vpath);
		if (id !== undefined) {
			const doc = this.files.get(id);
			if (doc !== undefined) {
				doc.move(vpath, this);
				if (!isDocument(doc)) {
					throw new Error("getDoc(): unexpected ifile type");
				}
				return doc;
			} else {
				// the ID exists, but the file doesn't
				this.log("[getDoc]: creating doc for shared ID");
				return this.createDoc(vpath, update);
			}
		} else {
			// the File exists, but the ID doesn't
			this.warn("[getDoc]: creating new shared ID for existing tfile");
			const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
			if (!(tfile instanceof TFile)) {
				throw new Error("unexpectedly missing tfile or got tfolder");
			}
			const newDocs = this.placeHold([tfile]);
			if (newDocs.length > 0) {
				return this.uploadDoc(vpath);
			} else {
				return this.createDoc(vpath, update);
			}
		}
	}

	public getCanvas(vpath: string, update = true): Canvas {
		const id = this.syncStore.get(vpath);
		if (id !== undefined) {
			const canvas = this.files.get(id);
			if (canvas !== undefined) {
				canvas.move(vpath, this);
				if (!isCanvas(canvas)) {
					throw new Error("getCanvas(): unexpected ifile type");
				}
				return canvas;
			} else {
				// the ID exists, but the file doesn't
				this.log("[getCanvas]: creating canvas for shared ID");
				return this.createCanvas(vpath, update);
			}
		} else {
			// the File exists, but the ID doesn't
			this.warn("[getCanvas]: creating new shared ID for existing tfile");
			const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
			if (!(tfile instanceof TFile)) {
				throw new Error("unexpectedly missing tfile or got tfolder");
			}
			const newDocs = this.placeHold([tfile]);
			if (newDocs.length > 0) {
				return this.uploadCanvas(vpath);
			} else {
				return this.createCanvas(vpath, update);
			}
		}
	}

	async markUploaded(file: IFile) {
		const mark = (file: IFile, meta: Meta) => {
			if (!this.syncStore) {
				return;
			}
			try {
				if (this.syncStore.willSet(file.path, meta)) {
					this.log("new meta", file.path, meta);
					this.ydoc.transact(() => {
						this.syncStore.markUploaded(file.path, meta);
					}, this);
				}
			} catch (e: unknown) {
				this.warn(`markUploaded failed for ${file.path}`, e);
			}
		};
		if (isDocument(file)) {
			const meta = makeDocumentMeta(file.guid);
			mark(file, meta);
			return;
		}
		if (isCanvas(file)) {
			const meta = makeCanvasMeta(file.guid);
			mark(file, meta);
			return;
		}
		if (isSyncFolder(file)) {
			const meta = makeFolderMeta(file.guid);
			mark(file, meta);
			return;
		}
		if (isSyncFile(file)) {
			const type = this.syncStore.typeRegistry.getTypeForPath(file.path);
			if (!type) {
				throw new Error("unexpected sync type");
			}
			const hash = await file.caf.hash();
			if (!hash) {
				throw new Error("file hash not yet computed");
			}
			const meta = makeFileMeta(
				type as SyncFileType,
				file.guid,
				file.mimetype,
				hash,
				file.stat.mtime,
			);
			mark(file, meta);
			return;
		}
	}

	getFile(tfile: TAbstractFile, update = true): IFile | null {
		const vpath = this.getVirtualPath(tfile.path);
		const guid = this.syncStore.get(vpath);

		// If file exists in sync store, use its metadata type to determine what to return
		if (guid) {
			const file = this.files.get(guid);
			if (file) {
				return file;
			}

			// File exists in sync store but not loaded - check its type from metadata
			const meta = this.syncStore.getMeta(vpath);
			if (meta) {
				if (meta.type === SyncType.Document) {
					return this.getDoc(vpath);
				}
				if (meta.type === SyncType.Canvas) {
					return this.getCanvas(vpath);
				}
				if (meta.type === SyncType.Folder) {
					return this.getSyncFolder(vpath, update);
				}
				// Default to sync file for other types
				if (this.syncStore.canSync(vpath)) {
					return this.getSyncFile(vpath, update);
				}
			}
		}

		// Fallback to extension-based detection for new files
		if (tfile instanceof TFolder) {
			return this.getSyncFolder(vpath, update);
		} else if (tfile instanceof TFile) {
			if (Document.checkExtension(vpath)) {
				return this.getDoc(vpath);
			}
			if (Canvas.checkExtension(vpath) && flags().enableCanvasSync) {
				return this.getCanvas(vpath);
			}
			if (this.syncStore.canSync(vpath)) {
				return this.getSyncFile(vpath, update);
			}
		}
		return null;
	}

	placeHold(newFiles: TAbstractFile[]): string[] {
		const newDocs: string[] = [];
		this.ydoc.transact(() => {
			newFiles.forEach((file) => {
				const vpath = this.getVirtualPath(file.path);
				if (this.isPendingDelete(vpath)) {
					this.log("skipping place hold for pending delete", vpath);
					return;
				}
				if (!this.syncStore.has(vpath)) {
					this.log("place hold new", vpath);
					this.syncStore.new(vpath);
					newDocs.push(vpath);
				}
			});
		}, this);
		return newDocs;
	}

	getOrCreateCanvas(guid: string, vpath: string): Canvas {
		const canvas =
			this.files.get(guid) || new Canvas(vpath, guid, this.loginManager, this);
		if (!isCanvas(canvas)) {
			throw new Error("getOrCreateCanvas(): unexpected ifile type");
		}
		canvas.move(vpath, this);
		return canvas;
	}

	downloadCanvas(vpath: string, update = true): Canvas {
		if (!Canvas.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error(`called download on item that is not in ids ${vpath}`);
		}
		const canvas = this.getOrCreateCanvas(guid, vpath);
		void canvas.markOrigin("remote");

		void this.backgroundSync.enqueueCanvasDownload(canvas);

		this.files.set(guid, canvas);
		this.fset.add(canvas, update);

		return canvas;
	}
	public uploadCanvas(vpath: string, update = true): Canvas {
		if (!Canvas.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const canvas = this.getOrCreateCanvas(guid, vpath);

		const originPromise = canvas.getOrigin();
		const awaitingUpdatesPromise = this.awaitingUpdates();

		void (async () => {
			const exists = await this.exists(canvas);
			if (!exists) {
				throw new Error(`Upload failed, doc does not exist at ${vpath}`);
			}
			const [contents, origin, awaitingUpdates] = await Promise.all([
				this.read(canvas),
				originPromise,
				awaitingUpdatesPromise,
			]);
			if (!awaitingUpdates && origin === undefined) {
				this.log(`[${canvas.path}] No Known Peers: Syncing file into ytext.`);
				void this.ydoc.transact(() => {
					try {
						void canvas.applyJSON(contents);
					} catch (e: unknown) {
						console.warn(contents);
						throw e;
					}
				}, this._persistence);
				void canvas.markOrigin("local");
				this.log(`[${canvas.path}] Uploading file`);
				await this.backgroundSync.enqueueSync(canvas);
				void this.markUploaded(canvas);
			}
		})();

		this.files.set(guid, canvas);
		this.fset.add(canvas, update);
		return canvas;
	}

	public createCanvas(vpath: string, update: boolean): Canvas {
		if (!Canvas.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const canvas = this.getOrCreateCanvas(guid, vpath);

		void this.whenReady().then(async () => {
			const synced = await canvas.getServerSynced();
			if (canvas.stat.size === 0 && !synced) {
				void this.backgroundSync.enqueueCanvasDownload(canvas);
			} else if (this.pendingUpload.get(canvas.path)) {
				void this.backgroundSync.enqueueSync(canvas);
			} else if (!synced && this.relayId) {
				// For relay-onprem: Canvas hasn't been synced to server yet
				void this.backgroundSync.enqueueCanvasDownload(canvas);
			}
		});

		this.files.set(guid, canvas);
		this.fset.add(canvas, update);
		return canvas;
	}

	public viewDoc(vpath: string): Document | undefined {
		const guid = this.syncStore.get(vpath);
		if (!guid) return;
		const doc = this.files.get(guid);
		if (!isDocument(doc)) {
			throw new Error("viewDoc(): unexpected ifile type");
		}
		return doc;
	}

	public viewSyncFile(vpath: string): SyncFile | undefined {
		const guid = this.syncStore.get(vpath);
		if (!guid) return;
		const file = this.files.get(guid);

		if (!file) {
			// File exists in sync store but not loaded yet
			this.debug(
				`viewSyncFile(): file not loaded yet, guid=${guid}, vpath=${vpath}`,
			);
			return undefined;
		}

		if (!isSyncFile(file)) {
			// File exists but is not a SyncFile (could be Canvas, Document, etc.)
			// This can happen when file types change due to feature flags or server metadata
			this.debug(
				`viewSyncFile(): file exists but is not SyncFile, guid=${guid}, vpath=${vpath}, actual type=${file.constructor.name}`,
			);
			return undefined;
		}
		return file;
	}

	getOrCreateDoc(guid: string, vpath: string): Document {
		const doc =
			this.files.get(guid) ||
			new Document(vpath, guid, this.loginManager, this);
		if (!isDocument(doc)) {
			throw new Error("unexpected ifile type");
		}
		doc.move(vpath, this);
		return doc;
	}

	downloadDoc(vpath: string, update = true): Document {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error(`called download on item that is not in ids ${vpath}`);
		}
		const doc = this.getOrCreateDoc(guid, vpath);
		void doc.markOrigin("remote");

		void this.backgroundSync.enqueueDownload(doc);

		this.files.set(guid, doc);
		this.fset.add(doc, update);

		return doc;
	}

	uploadDoc(vpath: string, update = true): Document {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid: string | undefined = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("missing guid");
		}
		const doc = this.getOrCreateDoc(guid, vpath);

		const originPromise = doc.getOrigin();
		const awaitingUpdatesPromise = this.awaitingUpdates();

		void (async () => {
			const exists = await this.exists(doc);
			if (!exists) {
				throw new Error(`Upload failed, doc does not exist at ${vpath}`);
			}
			const [contents, origin, awaitingUpdates] = await Promise.all([
				this.read(doc),
				originPromise,
				awaitingUpdatesPromise,
			]);
			const text = doc.ydoc.getText("contents");
			if (!awaitingUpdates && origin === undefined) {
				this.log(`[${doc.path}] No Known Peers: Syncing file into ytext.`);
				void this.ydoc.transact(() => {
					text.insert(0, contents);
				}, this._persistence);
				void doc.markOrigin("local");
				this.log(`[${doc.path}] Uploading file`);
				await this.backgroundSync.enqueueSync(doc);
				void this.markUploaded(doc);
			}
		})();

		this.files.set(guid, doc);
		this.fset.add(doc, update);
		return doc;
	}

	createDoc(vpath: string, update = true): Document {
		if (!Document.checkExtension(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const doc = this.getOrCreateDoc(guid, vpath);

		// The per-document catch-up probe reads this note's own store, and
		// reading it opens it. That is the fan-out enableLazyDocuments exists
		// to avoid, and it fires for every note in the share at load. The same
		// work is already queued at folder level by netSync's
		// enqueueSharedFolderSync, so under the flag this defers to that
		// rather than asking each note about itself up front.
		if (flags().enableLazyDocuments) {
			this.files.set(guid, doc);
			this.fset.add(doc, update);
			return doc;
		}

		void this.whenReady().then(async () => {
			const synced = await doc.getServerSynced();
			if (doc.tfile?.stat.size === 0 && !synced) {
				void this.backgroundSync.enqueueDownload(doc);
			} else if (this.pendingUpload.get(doc.path)) {
				void this.backgroundSync.enqueueSync(doc);
			} else if (!synced && this.relayId) {
				// For relay-onprem: Document hasn't been synced to server yet.
				// Use enqueueSync (WebSocket path) which properly reconciles:
				// if the relay is empty and local file has content, it uploads;
				// if the relay has content, it merges via diffMatchPatch.
				// enqueueDownload would try HTTP first (always 401 for CWT)
				// then fall back to WS, but with worse timing guarantees.
				void this.backgroundSync.enqueueSync(doc);
			}
		});

		this.files.set(guid, doc);
		this.fset.add(doc, update);

		return doc;
	}

	private getOrCreateSyncFolder(guid: string, vpath: string) {
		const file = this.files.get(guid) || new SyncFolder(vpath, guid, this);
		if (!isSyncFolder(file)) {
			throw new Error("unexpected ifile type");
		}
		file.move(vpath, this);
		return file;
	}

	getSyncFolder(vpath: string, update: boolean) {
		this.log("[getSyncFolder]", `getting syncfolder`);
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("expected guid");
		}
		const file = this.getOrCreateSyncFolder(guid, vpath);

		this.files.set(guid, file);
		this.fset.add(file, update);
		return file;
	}

	getOrCreateSyncFile(
		guid: string,
		vpath: string,
		hashOrTFile: TFile | string,
	): SyncFile {
		const file =
			this.files.get(guid) || new SyncFile(vpath, guid, this.hashStore, this);
		if (!isSyncFile(file)) {
			throw new Error(
				`getOrCreateSyncFile(): unexpected ifile type, guid=${guid}`,
			);
		}
		file.move(vpath, this);
		this.files.set(guid, file);
		return file;
	}

	syncFile(vpath: string, update: boolean) {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error(`called sync on item that is not in ids ${vpath}`);
		}
		const meta = this.syncStore.getMeta(vpath);
		if (!meta || !meta.hash) {
			return this.uploadSyncFile(vpath, update);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, meta.hash);

		void this.backgroundSync.enqueueSync(file);

		this.files.set(guid, file);
		this.fset.add(file, update);

		return file;
	}

	downloadSyncFile(vpath: string, update: boolean) {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error(`called download on item that is not in ids ${vpath}`);
		}
		const meta = this.syncStore.getMeta(vpath);
		if (!meta || !meta.hash) {
			return this.uploadSyncFile(vpath, update);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, meta.hash);

		void this.backgroundSync.enqueueDownload(file);

		this.files.set(guid, file);
		this.fset.add(file, update);

		return file;
	}

	uploadSyncFile(vpath: string, update = true): SyncFile {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid: string | undefined = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("missing guid");
		}
		const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
		if (!tfile) {
			throw new Error(`Upload failed, file does not exist at ${vpath}`);
		}
		if (!(tfile instanceof TFile)) {
			throw new Error(`Upload failed, expected file at ${vpath}`);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, tfile);

		void this.backgroundSync.enqueueSync(file);

		this.fset.add(file, update);
		return file;
	}

	getSyncFile(vpath: string, update = true): SyncFile {
		if (!this.syncStore.canSync(vpath)) {
			throw new Error("unexpected extension");
		}
		if (!this.synced && !this.syncStore.has(vpath)) {
			throw new Error(`potential for document split at ${vpath}`);
		}
		const guid: string | undefined = this.syncStore.get(vpath);
		if (!guid) {
			throw new Error("missing guid");
		}
		const tfile = this.vault.getAbstractFileByPath(this.getPath(vpath));
		if (!tfile) {
			throw new Error(`Upload failed, file does not exist at ${vpath}`);
		}
		if (!(tfile instanceof TFile)) {
			throw new Error(`Upload failed, expected file at ${vpath}`);
		}
		const file = this.getOrCreateSyncFile(guid, vpath, tfile);

		const meta = this.syncStore.getMeta(vpath);
		if (!meta) {
			this.log("get syncfile missing meta");
			void file.push();
		} else {
			void file.pull();
		}

		this.files.set(guid, file);
		this.fset.add(file, update);
		return file;
	}

	uploadFile(tfile: TAbstractFile, update = true): IFile {
		const vpath = this.getVirtualPath(tfile.path);
		if (tfile instanceof TFolder) {
			return this.getSyncFolder(vpath, update);
		} else if (tfile instanceof TFile) {
			if (Document.checkExtension(vpath)) {
				return this.uploadDoc(vpath, update);
			}
			if (Canvas.checkExtension(vpath) && flags().enableCanvasSync) {
				return this.uploadCanvas(vpath, update);
			}
			if (this.syncStore.canSync(vpath)) {
				return this.uploadSyncFile(vpath, update);
			}
		}
		throw new Error("unexpectedly unable to upload");
	}

	/**
	 * Claim-protected entry point for callers OUTSIDE the addLocalDocs()
	 * bulk-sync flow that discover a single new file and would otherwise
	 * call placeHold()+uploadFile() directly -- e.g. main.ts's vault
	 * "create" event, which (per its own long-standing comment) fires for
	 * every pre-existing file at startup, including ones under a
	 * freshly-loaded SharedFolder before that folder's own addLocalDocs()
	 * has necessarily run. Without this, that handler mints-then-uploads
	 * completely unprotected by the upload claim, re-opening the exact
	 * divergent-guid race addLocalDocs() closes for the SAME "two clients
	 * discover a brand-new shared vpath at once" scenario, just triggered by
	 * a different Obsidian event (TR-15-follow-up, #7c14871a).
	 */
	async claimAndUploadFile(tfile: TAbstractFile): Promise<void> {
		const vpath = this.getVirtualPath(tfile.path);
		const newDocs = this.placeHold([tfile]);
		if (newDocs.length === 0) {
			// Already known -- ordinary existing-file path, unchanged.
			await this.whenReady();
			this.getFile(tfile);
			return;
		}

		const raceable =
			Document.checkExtension(vpath) ||
			(Canvas.checkExtension(vpath) && flags().enableCanvasSync);
		if (!raceable) {
			this.uploadFile(tfile);
			return;
		}

		const { lost } = await this.claimUploadPaths([vpath]);
		if (lost.length === 0) {
			this.uploadFile(tfile);
			return;
		}
		if (Document.checkExtension(vpath)) {
			await this.adoptWinnerDoc(vpath);
		} else {
			await this.adoptWinnerCanvas(vpath);
		}
	}

	markPendingDelete(vpath: string) {
		this.pendingDeletes.add(vpath);
		this.log("marked pending delete", vpath);
	}

	clearPendingDelete(vpath: string) {
		this.pendingDeletes.delete(vpath);
		this.log("cleared pending delete", vpath);
	}

	isPendingDelete(vpath: string): boolean {
		return this.pendingDeletes.has(vpath);
	}

	/**
	 * Remove one entry from the sync store, and tear its document down.
	 *
	 * One entry is enough even when the path is a folder, which is not
	 * obvious and was got wrong once. Obsidian fires a `delete` event for
	 * every descendant before the folder's own, so each note has already
	 * removed itself by the time this runs for the folder. Measured on
	 * 2026-08-12 on both `vault.delete` and `fileManager.trashFile`, empty
	 * nested folders included; the admin repo's
	 * `scripts/dev/obsidian/checks/` has the run. A walk of the children here
	 * is dead weight that costs a pass over the whole store per event.
	 */
	deleteFile(vpath: string) {
		const guid = this.syncStore?.get(vpath);
		if (guid) {
			const doc = this.files.get(guid);
			this.ydoc.transact(() => {
				this.syncStore.delete(vpath);
				if (doc) {
					void doc.cleanup();
					this.fset.delete(doc);
				}
				this.files.delete(guid);
			}, this);
			// Fully tear down the Document/Canvas after removing from syncStore:
			// cancel pending debounced saves, disconnect WebSocket, destroy Y.Doc.
			// Without this, a stale requestSave debounce can re-create the file
			// on disk after clearPendingDelete runs.
			if (doc) {
				if (isDocument(doc)) {
					doc.requestSave.cancel();
					doc._tfile = null;
				}
				doc.disconnect();
				doc.destroy();
			}
		}
	}

	async trashFile(file: TAbstractFile): Promise<void> {
		await this.fileManager.trashFile(file);
	}

	renameFile(tfile: TAbstractFile, oldPath: string) {
		const newPath = tfile.path;
		let newVPath = "";
		let oldVPath = "";
		try {
			newVPath = this.getVirtualPath(newPath);
		} catch {
			this.log("Moving out of shared folder");
		}
		try {
			oldVPath = this.getVirtualPath(oldPath);
		} catch {
			this.log("Moving in from outside of shared folder");
		}

		if (!newVPath && !oldVPath) {
			// not related to shared folders
			return;
		} else if (!oldVPath) {
			// if this was moved from outside the shared folder context, we need to create a live doc
			this.assertPath(newPath);
			if (!this.syncStore.canSync(newVPath)) return;
			this.placeHold([tfile]);
			this.uploadFile(tfile);
		} else {
			// live doc exists
			const guid = this.syncStore.get(oldVPath);
			if (!guid) return;
			const file = this.files.get(guid);
			if (!newVPath) {
				// moving out of shared folder.. destroy the live doc.
				this.ydoc.transact(() => {
					this.syncStore.delete(oldVPath);
				}, this);
				if (file) {
					void file.cleanup();
					file.destroy();
					this.fset.delete(file);
				}
				this.files.delete(guid);
			} else {
				// moving within shared folder.. move the live doc.
				const guid = this.syncStore.get(oldVPath);
				if (!guid) {
					return;
				}
				const toMove: [string, string, string][] = [];
				if (file instanceof SyncFolder) {
					this.syncStore.forEach((meta, path) => {
						if (path.startsWith(oldVPath + sep)) {
							const destination = path.replace(oldVPath, newVPath);
							toMove.push([meta.id, path, destination]);
						}
					});
				}
				this.ydoc.transact(() => {
					this.syncStore.move(oldVPath, newVPath);
					if (file) {
						file.move(newVPath, this);
					}
					toMove.forEach((move) => {
						const [guid, oldVPath, newVPath] = move;
						this.syncStore.move(oldVPath, newVPath);
						const subdoc = this.files.get(guid);
						if (subdoc) {
							// it is critical that this happens within the transaction
							subdoc.move(newVPath, this);
						}
					});
				}, this);

				// Due to nested folder moves the tfiles and syncStore can diverge.
				// The nested folder moves are done in bulk in the sync store, but the tfile
				// events come in individually.
				this.syncStore.resolveMove(oldVPath);
			}
		}
	}

	destroy() {
		this.destroyed = true;
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.files.forEach((doc: IFile) => {
			doc.destroy();
			this.files.delete(doc.guid);
		});
		this.syncStore.destroy();
		this.syncSettingsManager.destroy();
		super.destroy();
		this.ydoc.destroy();
		this.fset.clear();
		this._settings.destroy();
		this._settings = null as unknown as NamespacedSettings<SharedFolderSettings, Record<string, unknown>>;
		this.diskBufferStore = null as unknown as DiskBufferStore;
		this.relayManager = null as unknown as RelayManager;
		this.backgroundSync = null as unknown as BackgroundSync;
		this.loginManager = null as unknown as LoginManager;
		this.tokenStore = null as unknown as LiveTokenStore;
		this.fileManager = null as unknown as FileManager;
		this.syncStore = null as unknown as SyncStore;
		this.syncSettingsManager = null as unknown as SyncSettingsManager;
		this.whenSyncedPromise?.destroy();
		this.whenSyncedPromise = null;
		this.readyPromise?.destroy();
		this.readyPromise = null;
		this.syncFileTreePromise?.destroy();
		this.syncFileTreePromise = null;
	}
}

export class SharedFolders extends ObservableSet<SharedFolder> {
	private folderBuilder: (
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
		scope?: ShareScope,
	) => SharedFolder;
	private _offRemoteUpdates?: () => void;

	constructor(
		private relayManager: RelayManager,
		private vault: Vault,
		folderBuilder: (
			path: string,
			guid: string,
			relayId?: string,
			awaitingUpdates?: boolean,
			scope?: ShareScope,
		) => SharedFolder,
		private settings: NamespacedSettings<SharedFolderSettings[]>,
	) {
		super();
		this.folderBuilder = folderBuilder;

		if (!this._offRemoteUpdates) {
			this._offRemoteUpdates = this.relayManager.remoteFolders.subscribe(
				(remotes) => {
					let updated = false;
					this.items().forEach((folder) => {
						const remote = remotes.find((remote) => remote.guid == folder.guid);
						if (folder.remote != remote) {
							updated = true;
						}
						folder.remote = remote;
					});
					if (updated) {
						this.update();
					}
				},
			);
		}
	}

	public delete(item: SharedFolder): boolean {
		item?.destroy();
		const deleted = super.delete(item);
		void this.settings.update((current) => {
			return current.filter((settings) => settings.guid !== item.guid);
		});
		return deleted;
	}

	update = debounce(() => this.notifyListeners(), 100);

	public get manager(): RelayManager {
		return this.relayManager;
	}

	lookup(path: string): SharedFolder | null {
		// Return the shared folder that contains the file -- agnostic of whether the file actually exists
		const folder = this.find((sharedFolder: SharedFolder) => {
			return sharedFolder.checkPath(path);
		});
		if (!folder) {
			return null;
		}
		return folder;
	}

	/**
	 * Returns the existing SharedFolder that would conflict by nesting with `path`,
	 * in either direction: `path` is a subfolder of an existing share, or `path`
	 * would itself contain an existing share. Null if sharing `path` is safe.
	 *
	 * Relay does not support nested shares -- two SharedFolders covering
	 * overlapping files race on which one processes a given file (TR-30).
	 * Single source of truth so callers (the file-menu UI and the actual
	 * creation guard in _new()) can't drift out of sync with each other.
	 */
	findNestingConflict(path: string): SharedFolder | null {
		const existingPaths = this.items().map((folder) => folder.path);
		const conflictPath = findNestingConflictPath(path, existingPaths, sep);
		if (conflictPath === null) {
			return null;
		}
		return this.find((folder) => folder.path === conflictPath) ?? null;
	}

	destroy() {
		this.items().forEach((folder) => {
			folder.destroy();
		});
		this.clear();
		if (this._offRemoteUpdates) {
			this._offRemoteUpdates();
		}
		this.unsubscribes.forEach((unsub) => {
			unsub();
		});
		this.relayManager = null as unknown as RelayManager;
		this.folderBuilder = null as unknown as (path: string, guid: string, relayId?: string, awaitingUpdates?: boolean) => SharedFolder;
	}

	load() {
		this._load(this.settings.get());
	}

	private _load(folders: SharedFolderSettings[]) {
		let updated = false;
		// Deduplicate by path: prefer entries with relay set
		const byPath = new Map<string, SharedFolderSettings>();
		for (const folder of folders) {
			const existing = byPath.get(folder.path);
			if (!existing || (folder.relay && !existing.relay)) {
				byPath.set(folder.path, folder);
			}
		}
		byPath.forEach((folder) => {
			const tFolder = this.vault.getFolderByPath(folder.path);
			if (!tFolder) {
				this.warn(`Invalid settings, ${folder.path} does not exist`);
				return;
			}
			const relayId = folder?.relay;
			try {
				this._new(
					folder.path,
					folder.guid,
					relayId,
					undefined,
					folder.scope ?? "folder",
				);
				updated = true;
			} catch (e: unknown) {
				this.warn(`Skipping duplicate folder ${folder.path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		});

		if (updated) {
			this.notifyListeners();
		}
	}

	private _new(
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
		scope: ShareScope = "folder",
	): SharedFolder {
		const existing = this.find(
			(folder) => folder.path == path && folder.guid == guid,
		);
		if (existing) {
			return existing;
		}
		const sameGuid = this.find((folder) => folder.guid == guid);
		if (sameGuid) {
			throw new Error(`This folder is already mounted at ${sameGuid.path}.`);
		}
		const samePath = this.find((folder) => folder.path == path);
		if (samePath) {
			throw new Error("Conflict: Tracked folder exists at this location.");
		}
		// A vault share covers every path, so it overlaps any other share by
		// definition. findNestingConflict compares prefixes and cannot see
		// that, and TR-30 is what overlapping shares cost: two shares racing
		// over the same file. So the vault share is exclusive, both ways.
		const existingVault = this.find((folder) => folder.isVaultScope);
		if (scope === "vault" && this.items().length > 0) {
			throw new Error(
				"Conflict: syncing the whole vault cannot be combined with folder shares.",
			);
		}
		if (existingVault) {
			throw new Error(
				"Conflict: this vault is already synced whole, so a folder cannot be shared separately.",
			);
		}
		const nestingConflict = this.findNestingConflict(path);
		if (nestingConflict) {
			throw new Error(
				`Conflict: nested shares are not supported (existing share at ${nestingConflict.path}).`,
			);
		}
		const folder = this.folderBuilder(
			path,
			guid,
			relayId,
			awaitingUpdates,
			scope,
		);
		this._set.add(folder);
		return folder;
	}

	new(
		path: string,
		guid: string,
		relayId?: string,
		awaitingUpdates?: boolean,
		scope: ShareScope = "folder",
	) {
		const folder = this._new(path, guid, relayId, awaitingUpdates, scope);
		this.notifyListeners();
		return folder;
	}
}
