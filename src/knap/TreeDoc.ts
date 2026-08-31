/**
 * The tree document: what a vault holds, and where each thing lives.
 *
 * Per cloud vault the server reserves the document id `tree`, holding two
 * Y.Maps.
 *
 * `files` is the one from vault path to document id. It is the whole answer
 * to "which note is which document": a move is a change to this map and
 * touches no note, a delete is a removal from it, and a note that is not in
 * it does not exist as far as any device or the server's markdown mirror is
 * concerned.
 *
 * `attachments` is the same idea for everything that is not a note, and it
 * maps a path to `{hash, size}` rather than to a document id, because an
 * attachment has no document: images, PDFs and audio do not merge, so their
 * bytes travel over the file routes instead (ADR-0076). Nothing is in both
 * maps, and that exclusivity is a safety property rather than tidiness. One
 * map with a kind field would put a device's attachment bookkeeping in a
 * position to name a note's path and delete another device's note.
 *
 * This module wraps both maps for the plugin. It never talks to the network:
 * the caller binds the underlying Y.Doc to a socket, and this class stays
 * honest whether the doc is live, offline, or in a test.
 */

import * as Y from "yjs";

export const TREE_DOC_ID = "tree";
const FILES = "files";
const ATTACHMENTS = "attachments";

export interface TreeChange {
	added: Map<string, string>;
	removed: Map<string, string>;
}

/** What the tree records about one attachment. The bytes are elsewhere. */
export interface AttachmentEntry {
	/** SHA-256 of the bytes, hex. The whole of "do I already have this". */
	hash: string;
	size: number;
}

export interface AttachmentChange {
	/** Appeared, or changed hash. An updated entry is in both halves. */
	added: Map<string, AttachmentEntry>;
	removed: Map<string, AttachmentEntry>;
}

export class TreeDoc {
	private readonly files: Y.Map<string>;
	private readonly attachmentMap: Y.Map<AttachmentEntry>;

	constructor(readonly doc: Y.Doc) {
		this.files = doc.getMap<string>(FILES);
		this.attachmentMap = doc.getMap<AttachmentEntry>(ATTACHMENTS);
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

	// -- the attachment half -------------------------------------------------

	/** path -> {hash, size}, a plain snapshot. */
	attachments(): Map<string, AttachmentEntry> {
		return new Map(this.attachmentMap.entries());
	}

	attachmentFor(path: string): AttachmentEntry | undefined {
		return this.attachmentMap.get(normalize(path));
	}

	/**
	 * Record an attachment. The bytes go over the file routes first: this is
	 * the entry that tells every other device they are there, so writing it
	 * before the upload lands would send them after bytes that do not exist.
	 */
	setAttachment(path: string, entry: AttachmentEntry): void {
		this.attachmentMap.set(normalize(path), entry);
	}

	removeAttachment(path: string): boolean {
		const clean = normalize(path);
		if (!this.attachmentMap.has(clean)) return false;
		this.attachmentMap.delete(clean);
		return true;
	}

	/**
	 * A rename. Unlike a note's, this one does move bytes: the server keys an
	 * attachment by its vault path, so the caller uploads at the new path and
	 * removes the old before calling this.
	 */
	moveAttachment(from: string, to: string): AttachmentEntry {
		const clean = normalize(from);
		const entry = this.attachmentMap.get(clean);
		if (!entry) {
			throw new Error(`No attachment at ${from} to move.`);
		}
		this.doc.transact(() => {
			this.attachmentMap.delete(clean);
			this.attachmentMap.set(normalize(to), entry);
		});
		return entry;
	}

	/**
	 * Watch the attachment map. An entry whose hash changed counts as both
	 * removed and added, so a caller that downloads the added half and deletes
	 * the removed half has to check for the path in both, exactly as it does
	 * for a moved note. Returns an unsubscribe.
	 */
	onAttachmentChange(callback: (change: AttachmentChange) => void): () => void {
		const observer = (event: Y.YMapEvent<AttachmentEntry>) => {
			const added = new Map<string, AttachmentEntry>();
			const removed = new Map<string, AttachmentEntry>();
			for (const [key, change] of event.changes.keys) {
				if (change.action !== "delete") {
					added.set(key, this.attachmentMap.get(key) as AttachmentEntry);
				}
				if (change.action !== "add") {
					removed.set(key, change.oldValue as AttachmentEntry);
				}
			}
			callback({ added, removed });
		};
		this.attachmentMap.observe(observer);
		return () => this.attachmentMap.unobserve(observer);
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

/** A note is a `.md`, and everything else in a vault is an attachment. */
export function isNote(path: string): boolean {
	return path.toLowerCase().endsWith(".md");
}

/**
 * A path Obsidian's own settings and plugins live under. The server refuses
 * these outright, so anything that offered one would earn a 422 and a
 * sentence on screen about a file the person never put there.
 */
export function isHidden(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("."));
}
