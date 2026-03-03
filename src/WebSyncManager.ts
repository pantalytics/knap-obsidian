/**
 * Web Sync Manager
 *
 * Handles automatic synchronization of documents to web when shares have auto-sync enabled.
 */

import { TFile, TFolder, Vault, debounce } from "obsidian";
import { RelayOnPremShareClientManager } from "./RelayOnPremShareClientManager";
import type { FolderItem } from "./RelayOnPremShareClient";
import { curryLog } from "./debug";

const log = curryLog("[WebSyncManager]");

interface ShareInfo {
	shareId: string;
	serverId: string;
	lastSync: number;
	kind: "doc" | "folder";
	webSlug?: string;
}

export class WebSyncManager {
	private vault: Vault;
	private clientManager: RelayOnPremShareClientManager;
	private autoSyncShares: Map<string, ShareInfo> = new Map();
	private syncDebounceMs = 2000; // Wait 2 seconds after last change
	private minSyncIntervalMs = 5000; // Minimum 5 seconds between syncs (rate limiting)

	// Debounced sync function per file path
	private debouncedSyncMap: Map<string, () => void> = new Map();

	constructor(
		vault: Vault,
		clientManager: RelayOnPremShareClientManager
	) {
		this.vault = vault;
		this.clientManager = clientManager;
	}

	/**
	 * Register a share for automatic synchronization
	 */
	registerAutoSyncShare(
		filePath: string,
		shareId: string,
		serverId: string,
		kind: "doc" | "folder" = "doc",
		webSlug?: string
	): void {
		log("Registering auto-sync share", { filePath, shareId, kind, webSlug });
		this.autoSyncShares.set(filePath, {
			shareId,
			serverId,
			lastSync: 0,
			kind,
			webSlug,
		});

		// Create debounced sync function for this file/folder
		if (!this.debouncedSyncMap.has(filePath)) {
			this.debouncedSyncMap.set(
				filePath,
				debounce(
					() => this.syncFile(filePath),
					this.syncDebounceMs,
					true
				)
			);
		}
	}

	/**
	 * Unregister a share from automatic synchronization
	 */
	unregisterAutoSyncShare(filePath: string): void {
		log("Unregistering auto-sync share", { filePath });
		this.autoSyncShares.delete(filePath);
		this.debouncedSyncMap.delete(filePath);
	}

	/**
	 * Handle file modification event
	 */
	async onFileModified(file: TFile): Promise<void> {
		// First check for direct doc share match
		let shareInfo = this.autoSyncShares.get(file.path);
		let matchedPath = file.path;

		// If no direct match, check if file is inside a folder share
		if (!shareInfo) {
			for (const [folderPath, info] of this.autoSyncShares.entries()) {
				if (info.kind === "folder" && file.path.startsWith(folderPath + "/")) {
					shareInfo = info;
					matchedPath = folderPath;
					log("File is inside auto-sync folder", { filePath: file.path, folderPath });
					break;
				}
			}
		}

		if (!shareInfo) return;

		// Rate limiting check
		const now = Date.now();
		if (now - shareInfo.lastSync < this.minSyncIntervalMs) {
			log("Rate limited, scheduling sync", {
				path: file.path,
				timeSinceLastSync: now - shareInfo.lastSync,
			});
			// Schedule sync after rate limit expires
			const debouncedSync = this.debouncedSyncMap.get(matchedPath);
			if (debouncedSync) debouncedSync();
			return;
		}

		log("File modified, triggering sync", { path: file.path, kind: shareInfo.kind });

		// For folder shares, sync just the modified file
		if (shareInfo.kind === "folder") {
			await this.syncFolderFile(file, shareInfo);
		} else {
			const debouncedSync = this.debouncedSyncMap.get(matchedPath);
			if (debouncedSync) debouncedSync();
		}
	}

	/**
	 * Synchronize a single file within a folder share to web
	 */
	private async syncFolderFile(file: TFile, shareInfo: ShareInfo): Promise<void> {
		if (!shareInfo.webSlug) {
			log("No web_slug for folder share, fetching...", { shareId: shareInfo.shareId });
			// Try to get the slug from the share
			const client = this.clientManager.getClient(shareInfo.serverId);
			if (client) {
				const share = await client.getShare(shareInfo.shareId);
				if (share?.web_slug) {
					shareInfo.webSlug = share.web_slug;
				} else {
					log("Share has no web_slug, skipping sync");
					return;
				}
			}
		}

		try {
			const content = await this.vault.read(file);

			// Find the relative path within the folder
			const folderPath = Array.from(this.autoSyncShares.entries())
				.find(([_, info]) => info === shareInfo)?.[0];

			if (!folderPath) {
				log("Could not find folder path for share info");
				return;
			}

			const relativePath = file.path.substring(folderPath.length + 1); // +1 for the "/"

			log("Syncing folder file", {
				folderPath,
				relativePath,
				slug: shareInfo.webSlug,
			});

			await this.clientManager.syncFolderFileContent(
				shareInfo.serverId,
				shareInfo.webSlug!,
				relativePath,
				content
			);

			shareInfo.lastSync = Date.now();
			log("Auto-synced folder file to web", {
				filePath: file.path,
				relativePath,
				slug: shareInfo.webSlug,
			});
		} catch (error: unknown) {
			log("Failed to auto-sync folder file", {
				filePath: file.path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Synchronize a file to web
	 */
	private async syncFile(filePath: string): Promise<void> {
		const shareInfo = this.autoSyncShares.get(filePath);
		if (!shareInfo) {
			log("Share info not found for path", { filePath });
			return;
		}

		// Rate limiting check (in case debounce fired early)
		const now = Date.now();
		if (now - shareInfo.lastSync < this.minSyncIntervalMs) {
			log("Rate limited on sync", {
				filePath,
				timeSinceLastSync: now - shareInfo.lastSync,
			});
			return;
		}

		try {
			const file = this.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) {
				log("File not found or not a TFile", { filePath });
				return;
			}

			const content = await this.vault.read(file);
			const client = this.clientManager.getClient(shareInfo.serverId);
			if (!client) {
				log("Client not found for server", {
					serverId: shareInfo.serverId,
				});
				return;
			}

			// Get share to find slug
			const share = await client.getShare(shareInfo.shareId);
			if (!share?.web_slug) {
				log("Share not found or missing web_slug", {
					shareId: shareInfo.shareId,
				});
				return;
			}

			// Sync content to web
			await client.updateShare(shareInfo.shareId, {
				web_content: content,
			});
			shareInfo.lastSync = Date.now();

			log("Auto-synced file to web", {
				filePath,
				slug: share.web_slug,
			});
		} catch (error: unknown) {
			log("Failed to auto-sync file", {
				filePath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Handle file creation — update web_folder_items for affected folder shares
	 */
	async onFileCreated(file: TFile): Promise<void> {
		for (const [folderPath, shareInfo] of this.autoSyncShares.entries()) {
			if (shareInfo.kind !== "folder") continue;
			if (!file.path.startsWith(folderPath + "/")) continue;

			log("File created in auto-sync folder, updating web_folder_items", {
				filePath: file.path,
				folderPath,
				shareId: shareInfo.shareId,
			});

			try {
				const items = this.getFolderItems(folderPath);
				await this.clientManager.updateShare(
					shareInfo.serverId,
					shareInfo.shareId,
					{ web_folder_items: items }
				);
				log("Updated web_folder_items after creation", {
					folderPath,
					itemCount: items.length,
				});
			} catch (error: unknown) {
				log("Failed to update web_folder_items after creation", {
					filePath: file.path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
	}

	/**
	 * Handle file rename — update web_folder_items for affected folder shares
	 */
	async onFileRenamed(newPath: string, oldPath: string): Promise<void> {
		for (const [folderPath, shareInfo] of this.autoSyncShares.entries()) {
			if (shareInfo.kind !== "folder") continue;
			// File moved into, out of, or within this folder
			if (
				!newPath.startsWith(folderPath + "/") &&
				!oldPath.startsWith(folderPath + "/")
			) continue;

			log("File renamed in auto-sync folder, updating web_folder_items", {
				oldPath,
				newPath,
				folderPath,
				shareId: shareInfo.shareId,
			});

			try {
				const items = this.getFolderItems(folderPath);
				await this.clientManager.updateShare(
					shareInfo.serverId,
					shareInfo.shareId,
					{ web_folder_items: items }
				);
				log("Updated web_folder_items after rename", {
					folderPath,
					itemCount: items.length,
				});
			} catch (error: unknown) {
				log("Failed to update web_folder_items after rename", {
					oldPath,
					newPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			// Don't return early — file could affect multiple folder shares (moved between)
		}
	}

	/**
	 * Handle file deletion — update web_folder_items for affected folder shares
	 */
	async onFileDeleted(filePath: string): Promise<void> {
		for (const [folderPath, shareInfo] of this.autoSyncShares.entries()) {
			if (shareInfo.kind !== "folder") continue;
			if (!filePath.startsWith(folderPath + "/")) continue;

			log("File deleted from auto-sync folder, updating web_folder_items", {
				filePath,
				folderPath,
				shareId: shareInfo.shareId,
			});

			try {
				const items = this.getFolderItems(folderPath);
				await this.clientManager.updateShare(
					shareInfo.serverId,
					shareInfo.shareId,
					{ web_folder_items: items }
				);
				log("Updated web_folder_items after deletion", {
					folderPath,
					itemCount: items.length,
				});
			} catch (error: unknown) {
				log("Failed to update web_folder_items after deletion", {
					filePath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
	}

	/**
	 * Scan folder for current items (md/canvas files and subfolders)
	 */
	private getFolderItems(folderPath: string): FolderItem[] {
		const folder = this.vault.getAbstractFileByPath(folderPath);
		if (!folder || !(folder instanceof TFolder)) return [];

		const items: FolderItem[] = [];
		const process = (f: TFolder) => {
			for (const child of f.children) {
				const rel = child.path.substring(folderPath.length + 1);
				if (child instanceof TFile) {
					if (child.extension === "canvas") {
						items.push({ path: rel, name: child.basename, type: "canvas" });
					} else if (child.extension === "md") {
						items.push({ path: rel, name: child.basename, type: "doc" });
					}
				} else if (child instanceof TFolder) {
					items.push({ path: rel, name: child.name, type: "folder" });
					process(child);
				}
			}
		};
		process(folder);
		return items;
	}

	/**
	 * Sync folder structure (web_folder_items) to web for a specific share.
	 * Called from context menu "Sync" to ensure deleted files are reflected on web-publish.
	 */
	async syncFolderStructureToWeb(
		folderPath: string,
		serverId: string,
		shareId: string,
	): Promise<void> {
		const items = this.getFolderItems(folderPath);
		await this.clientManager.updateShare(serverId, shareId, {
			web_folder_items: items,
		});
		log("Synced folder structure to web", { folderPath, itemCount: items.length });
	}

	/**
	 * Get all registered auto-sync paths
	 */
	getAutoSyncPaths(): string[] {
		return Array.from(this.autoSyncShares.keys());
	}

	/**
	 * Check if a path is registered for auto-sync
	 */
	isAutoSync(filePath: string): boolean {
		return this.autoSyncShares.has(filePath);
	}

	/**
	 * Clean up resources
	 */
	destroy(): void {
		log("Destroying WebSyncManager");
		this.autoSyncShares.clear();
		this.debouncedSyncMap.clear();
	}
}
