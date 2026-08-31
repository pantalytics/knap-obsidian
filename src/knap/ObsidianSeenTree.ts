/**
 * What this device last agreed with, kept in the plugin's own directory.
 *
 * The binding needs one fact across a restart: which notes were in the tree
 * the last time the disk and the tree matched. With it, a file that is gone
 * is a note somebody deleted; without it, a file that is gone is a note that
 * has not arrived yet, and the two are indistinguishable.
 *
 * It lives beside the plugin rather than in its settings for two reasons.
 * It is a fact about this device and no other, so it may never ride along
 * with anything that syncs (ADR-0067 refuses `plugins/**` for exactly this),
 * and a vault of a few thousand notes makes it far larger than the settings
 * blob that is rewritten on every change.
 *
 * The cloud vault's id is written next to the paths and checked on the way
 * back in. A record made against one cloud vault says nothing about another,
 * and reading it as though it did is how a link to a second vault would
 * start by deleting notes out of it.
 */

import { normalizePath } from "obsidian";
import type { DataAdapter } from "obsidian";

import type { SeenTree } from "./VaultBinding";

interface Stored {
	cloudVaultId: string;
	files: Record<string, string>;
}

export class ObsidianSeenTree implements SeenTree {
	constructor(
		private readonly adapter: DataAdapter,
		private readonly path: string,
		private readonly cloudVaultId: string,
	) {}

	/**
	 * The remembered tree, or an empty one.
	 *
	 * Every failure lands on empty on purpose. An empty record is the state
	 * a first link is in, and it deletes nothing on either side: the binding
	 * only removes a note where the record positively says it used to be
	 * there. A record that cannot be read is one this device does not have.
	 */
	async load(): Promise<Map<string, string>> {
		try {
			const raw = await this.adapter.read(normalizePath(this.path));
			const stored = JSON.parse(raw) as Stored;
			if (stored.cloudVaultId !== this.cloudVaultId) return new Map();
			return new Map(Object.entries(stored.files ?? {}));
		} catch {
			return new Map();
		}
	}

	async save(entries: Map<string, string>): Promise<void> {
		const stored: Stored = {
			cloudVaultId: this.cloudVaultId,
			files: Object.fromEntries(entries),
		};
		await this.adapter.write(normalizePath(this.path), JSON.stringify(stored));
	}

	async forget(): Promise<void> {
		const clean = normalizePath(this.path);
		if (await this.adapter.exists(clean)) {
			await this.adapter.remove(clean);
		}
	}
}
