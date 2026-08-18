/**
 * The tree document: the one map from vault path to document id.
 *
 * Per cloud vault the server reserves the document id `tree`, holding a
 * Y.Map named `files`. It is the whole answer to "which note is which
 * document": a move is a change to this map and touches no note, a delete
 * is a removal from it, and a note that is not in it does not exist as far
 * as any device or the server's markdown mirror is concerned.
 *
 * This module wraps that map for the plugin. It never talks to the network:
 * the caller binds the underlying Y.Doc to a socket, and this class stays
 * honest whether the doc is live, offline, or in a test.
 */

import * as Y from "yjs";

export const TREE_DOC_ID = "tree";
const FILES = "files";

export interface TreeChange {
	added: Map<string, string>;
	removed: Map<string, string>;
}

export class TreeDoc {
	private readonly files: Y.Map<string>;

	constructor(readonly doc: Y.Doc) {
		this.files = doc.getMap<string>(FILES);
	}

	/** path -> document id, a plain snapshot. */
	entries(): Map<string, string> {
		return new Map(this.files.entries());
	}

	docIdFor(path: string): string | undefined {
		return this.files.get(normalize(path));
	}

	pathFor(docId: string): string | undefined {
		for (const [path, id] of this.files.entries()) {
			if (id === docId) return path;
		}
		return undefined;
	}

	/**
	 * The document id for a note, minting one if the note is new.
	 * Deciding ids client-side is what lets a device create notes offline;
	 * a UUID collision is the kind of luck nobody has.
	 */
	ensureNote(path: string): string {
		const clean = normalize(path);
		const existing = this.files.get(clean);
		if (existing) return existing;
		const docId = crypto.randomUUID().replace(/-/g, "");
		this.files.set(clean, docId);
		return docId;
	}

	/** A move is a tree change and nothing else. The id survives it. */
	move(from: string, to: string): string {
		const clean = normalize(from);
		const docId = this.files.get(clean);
		if (!docId) {
			throw new Error(`No note at ${from} to move.`);
		}
		this.doc.transact(() => {
			this.files.delete(clean);
			this.files.set(normalize(to), docId);
		});
		return docId;
	}

	/** Leaving the tree is what deletion is. History stays on the server. */
	remove(path: string): boolean {
		const clean = normalize(path);
		if (!this.files.has(clean)) return false;
		this.files.delete(clean);
		return true;
	}

	/**
	 * Watch the tree. The callback gets what appeared and what left; a moved
	 * note shows up in both, under the same id. Returns an unsubscribe.
	 */
	onChange(callback: (change: TreeChange) => void): () => void {
		const observer = (event: Y.YMapEvent<string>) => {
			const added = new Map<string, string>();
			const removed = new Map<string, string>();
			for (const [key, change] of event.changes.keys) {
				if (change.action === "add") {
					added.set(key, this.files.get(key) as string);
				} else if (change.action === "delete") {
					removed.set(key, change.oldValue as string);
				} else {
					removed.set(key, change.oldValue as string);
					added.set(key, this.files.get(key) as string);
				}
			}
			callback({ added, removed });
		};
		this.files.observe(observer);
		return () => this.files.unobserve(observer);
	}
}

/**
 * One spelling per path: forward slashes, no leading slash, no `.` segments.
 * The server refuses escapes on its side too; normalizing here keeps two
 * devices from writing `Notes/a.md` and `./Notes/a.md` as different notes.
 */
export function normalize(path: string): string {
	const parts = path
		.replace(/\\/g, "/")
		.split("/")
		.filter((part) => part !== "" && part !== ".");
	if (parts.some((part) => part === "..")) {
		throw new Error("A vault path never leaves the vault.");
	}
	return parts.join("/");
}
