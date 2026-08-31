/**
 * Obsidian's vault, seen through the binding's FileStore seam.
 *
 * Thin on purpose: every rule lives in VaultBinding where jest can reach
 * it, and this adapter only translates. Two translations are worth
 * naming. Obsidian fires events for programmatic writes exactly like for
 * keystrokes, and the binding is idempotent precisely so this adapter does
 * not have to tell them apart. And Obsidian's `create` events replay for
 * every existing file at vault load, so the adapter starts listening only
 * when told, after the link-time reconcile has the tree.
 */

import { FileManager, normalizePath, TAbstractFile, TFile, Vault } from "obsidian";

import { isNote } from "./TreeDoc";
import type { FileEvent, FileStore } from "./VaultBinding";

export class ObsidianFileStore implements FileStore {
	constructor(
		private readonly vault: Vault,
		private readonly fileManager: FileManager,
	) {}

	private file(path: string): TFile | null {
		const found = this.vault.getAbstractFileByPath(normalizePath(path));
		return found instanceof TFile ? found : null;
	}

	async read(path: string): Promise<string | null> {
		const file = this.file(path);
		return file ? await this.vault.read(file) : null;
	}

	async write(path: string, text: string): Promise<void> {
		const clean = normalizePath(path);
		const existing = this.file(clean);
		if (existing) {
			await this.vault.modify(existing, text);
			return;
		}
		await this.ensureParent(clean);
		await this.vault.create(clean, text);
	}

	async readBinary(path: string): Promise<ArrayBuffer | null> {
		const file = this.file(path);
		return file ? await this.vault.readBinary(file) : null;
	}

	async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
		const clean = normalizePath(path);
		const existing = this.file(clean);
		if (existing) {
			await this.vault.modifyBinary(existing, content);
			return;
		}
		await this.ensureParent(clean);
		await this.vault.createBinary(clean, content);
	}

	private async ensureParent(clean: string): Promise<void> {
		const parent = clean.split("/").slice(0, -1).join("/");
		if (parent && !this.vault.getAbstractFileByPath(parent)) {
			await this.vault.createFolder(parent).catch(() => undefined);
		}
	}

	async remove(path: string): Promise<void> {
		const file = this.file(path);
		if (file) {
			// The user's own deletion preference, so a remote delete stays as
			// recoverable here as one they made themselves.
			await this.fileManager.trashFile(file);
		}
	}

	async rename(from: string, to: string): Promise<void> {
		const file = this.file(from);
		if (file) {
			await this.vault.rename(file, normalizePath(to));
		}
	}

	async listNotes(): Promise<string[]> {
		return this.vault
			.getFiles()
			.filter((file) => isNote(file.path))
			.map((file) => file.path);
	}

	/**
	 * Everything that is not a note. Obsidian's own `getFiles` already
	 * leaves out `.obsidian`, so the vault's settings and plugins do not
	 * turn up here and never travel (ADR-0067).
	 */
	async listAttachments(): Promise<string[]> {
		return this.vault
			.getFiles()
			.filter((file) => !isNote(file.path))
			.map((file) => file.path);
	}

	onChange(callback: (event: FileEvent) => void): () => void {
		// Both kinds of file are reported and each binding takes its own
		// half. Filtering here is what kept every attachment in the vault
		// invisible to the plugin for the whole of phase 2.
		const toEvent = (type: FileEvent["type"]) => (file: TAbstractFile, oldPath?: string) => {
			if (file instanceof TFile) {
				callback({ type, path: file.path, oldPath });
			}
		};
		const created = this.vault.on("create", toEvent("create"));
		const modified = this.vault.on("modify", toEvent("modify"));
		const deleted = this.vault.on("delete", toEvent("delete"));
		const renamed = this.vault.on("rename", toEvent("rename"));
		return () => {
			this.vault.offref(created);
			this.vault.offref(modified);
			this.vault.offref(deleted);
			this.vault.offref(renamed);
		};
	}
}
