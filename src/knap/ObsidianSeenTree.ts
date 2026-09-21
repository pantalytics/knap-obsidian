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
 *
 * A `narrowed` flag is written beside it and checked the same way. Before
 * #152 the record was the tree saved whole, so a device whose fill had not
 * finished wrote down paths it had never fetched; the flag says the file in
 * hand was written under the rule that only what is on this disk goes in it.
 * A record without the flag was written under the old rule and cannot be
 * told apart from an honest one by reading it, so it is not read at all.
 *
 * `bases` rides in the same file: per document id, the sha256 of the text
 * this device last held on both sides. A record written before bases existed
 * simply has none, and a note without a base settles the way linking always
 * has, with a conflict copy rather than a guess (issues #142, #169).
 */

import { normalizePath } from "obsidian";
import type { DataAdapter } from "obsidian";

import type { SeenTree } from "./VaultBinding";

interface Stored {
	cloudVaultId: string;
	/** Written only by a version whose record is what is on this disk. */
	narrowed?: boolean;
	files: Record<string, string>;
	/** Document id -> sha256 of the text last agreed with. */
	bases?: Record<string, string>;
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
	 * there. A record that cannot be read is one this device does not have,
	 * and so is one this device cannot vouch for: a pre-#152 record claims
	 * every path in the tree, which on an unfinished fill is a claim to have
	 * had notes that never arrived. Upgrading costs a refill; believing it
	 * costs those notes, on every device and in the cloud vault.
	 */
	async load(): Promise<Map<string, string>> {
		return new Map(Object.entries((await this.read())?.files ?? {}));
	}

	/** The bases, or none. None is safe: see the class comment. */
	async loadBases(): Promise<Map<string, string>> {
		return new Map(Object.entries((await this.read())?.bases ?? {}));
	}

	/** The record, if there is one this device can vouch for. */
	private async read(): Promise<Stored | null> {
		try {
			const raw = await this.adapter.read(normalizePath(this.path));
			const stored = JSON.parse(raw) as Stored;
			if (stored.cloudVaultId !== this.cloudVaultId) return null;
			if (stored.narrowed !== true) return null;
			return stored;
		} catch {
			return null;
		}
	}

	async save(entries: Map<string, string>, bases: Map<string, string>): Promise<void> {
		const stored: Stored = {
			cloudVaultId: this.cloudVaultId,
			narrowed: true,
			files: Object.fromEntries(entries),
			bases: Object.fromEntries(bases),
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
