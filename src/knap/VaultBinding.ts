/**
 * The binding: local files on one side, live documents on the other.
 *
 * This is the engine of phase 2, and it is deliberately blind to both ends.
 * Files come through a `FileStore` (Obsidian in production, memory in
 * tests), documents through a `VaultDocs` (a `KnapVaultClient` in
 * production, linked in-memory docs in tests), so every rule in here runs
 * under jest and the same code ships.
 *
 * The rules, and there are few:
 *
 * - A local edit becomes a minimal splice on the note's Text: common prefix
 *   and suffix stay untouched, so concurrent edits elsewhere in the note
 *   merge instead of being steamrolled. Never a replacement (ADR-0010).
 * - A remote edit becomes a file write, and a tree change becomes a create,
 *   a rename or a removal on disk.
 * - Both directions are idempotent instead of bookkept: an event that finds
 *   file and document already equal does nothing, which is what breaks
 *   every echo loop without a ledger of "writes that were ours".
 * - At link time nothing is guessed: local-only notes upload, remote-only
 *   notes download, and a note that exists on both sides with different
 *   text keeps the cloud text while the local text survives as a conflict
 *   copy beside it. Nothing is ever silently lost.
 */

import * as Y from "yjs";

import { buildConflictCopyPath } from "../conflictCopyPath";
import { TreeDoc, normalize } from "./TreeDoc";

export interface FileEvent {
	type: "create" | "modify" | "delete" | "rename";
	path: string;
	oldPath?: string;
}

/** What the binding needs from a vault's files. Obsidian adapts to this. */
export interface FileStore {
	read(path: string): Promise<string | null>;
	write(path: string, text: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	listNotes(): Promise<string[]>;
	onChange(callback: (event: FileEvent) => void): () => void;
}

/** What the binding needs from the wire. KnapVaultClient satisfies it. */
export interface VaultDocs {
	tree(): TreeDoc;
	note(docId: string): { doc: Y.Doc; synced: Promise<void> };
}

const CONTENT = "content";

/** Y.Text implements toString; the lint rule cannot see that through AbstractType. */
function textOf(content: Y.Text): string {
	// eslint-disable-next-line @typescript-eslint/no-base-to-string -- Y.Text has a real toString
	return content.toString();
}

export class VaultBinding {
	private stopFileEvents: (() => void) | null = null;
	private stopTreeEvents: (() => void) | null = null;
	private noteObservers = new Map<string, () => void>();
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly files: FileStore,
		private readonly docs: VaultDocs,
		private readonly conflictLabel = () => `conflict ${new Date().toISOString().slice(0, 10)}`,
	) {}

	/**
	 * Link: reconcile both sides once, then follow both event streams.
	 * Everything runs through one queue, so a burst of events cannot
	 * interleave two half-finished reconciliations.
	 */
	async start(): Promise<void> {
		await this.enqueue(() => this.reconcileAll());
		this.stopFileEvents = this.files.onChange((event) => {
			void this.enqueue(() => this.onFileEvent(event));
		});
		this.stopTreeEvents = this.docs.tree().onChange((change) => {
			void this.enqueue(async () => {
				for (const [path, docId] of change.added) {
					await this.bindNote(path, docId);
				}
				for (const [path, docId] of change.removed) {
					// A move announces itself as removed+added under one id, and
					// the added half above already wrote the new file, so the old
					// path goes either way. Only a note that left the tree for
					// good stops being watched.
					await this.files.remove(path);
					if (this.docs.tree().pathFor(docId) === undefined) {
						this.unobserveNote(docId);
					}
				}
			});
		});
	}

	stop(): void {
		this.stopFileEvents?.();
		this.stopTreeEvents?.();
		for (const stop of this.noteObservers.values()) stop();
		this.noteObservers.clear();
	}

	/** Wait for everything queued so far; tests and shutdown use it. */
	flush(): Promise<void> {
		return this.enqueue(async () => undefined);
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(work, work);
		return this.queue;
	}

	// -- link time -----------------------------------------------------------

	private async reconcileAll(): Promise<void> {
		const tree = this.docs.tree();
		const local = new Set((await this.files.listNotes()).map(normalize));
		const remote = tree.entries();

		for (const path of local) {
			if (!remote.has(path)) {
				await this.pushNote(path);
			}
		}
		for (const [path, docId] of remote) {
			await this.bindNote(path, docId);
		}
	}

	// -- local to remote ------------------------------------------------------

	private async onFileEvent(event: FileEvent): Promise<void> {
		const tree = this.docs.tree();
		if (event.type === "rename" && event.oldPath) {
			const from = normalize(event.oldPath);
			if (tree.docIdFor(from) !== undefined) {
				tree.move(from, event.path);
				return;
			}
			await this.pushNote(event.path);
			return;
		}
		if (event.type === "delete") {
			const path = normalize(event.path);
			const docId = tree.docIdFor(path);
			tree.remove(path);
			if (docId) this.unobserveNote(docId);
			return;
		}
		// create and modify converge: bring the document to the file's text.
		await this.pushNote(event.path);
	}

	private async pushNote(path: string): Promise<void> {
		const clean = normalize(path);
		if (!clean.endsWith(".md")) return;
		const text = await this.files.read(clean);
		if (text === null) return; // gone again before we got to it

		const tree = this.docs.tree();
		const docId = tree.ensureNote(clean);
		const { doc, synced } = this.docs.note(docId);
		await synced;
		const content = doc.getText(CONTENT);
		if (textOf(content) !== text) {
			splice(content, textOf(content), text, doc);
		}
		this.observeNote(clean, docId);
	}

	// -- remote to local ------------------------------------------------------

	/**
	 * Take one note from the cloud onto disk, and start watching it.
	 *
	 * The three-way choice below is why this is one method rather than a
	 * download at link time and a simpler one for notes that arrive later.
	 * A note can turn up in the tree at a path where an unsynced local file
	 * already sits: somebody wrote it on this laptop while another device
	 * made a note of the same name. Writing the cloud text over it would be
	 * the one thing this binding promises never to do.
	 */
	private async bindNote(path: string, docId: string): Promise<void> {
		const { doc, synced } = this.docs.note(docId);
		await synced;
		const content = doc.getText(CONTENT);
		const docText = textOf(content);
		const fileText = await this.files.read(path);

		if (fileText === null) {
			await this.files.write(path, docText);
		} else if (fileText !== docText) {
			if (docText === "") {
				// A minted note nobody typed in yet: the local text is the
				// note. A note somebody deliberately emptied looks exactly the
				// same from here and nothing can tell them apart, so this goes
				// the way that cannot lose anything.
				splice(content, "", fileText, doc);
			} else {
				// Both sides wrote. The cloud text wins the path; the local
				// text survives beside it, named for what happened, and pushed
				// explicitly because this can run before the event stream is on.
				const copy = buildConflictCopyPath(path, this.conflictLabel());
				await this.files.write(copy, fileText);
				await this.pushNote(copy);
				await this.files.write(path, docText);
			}
		}
		this.observeNote(path, docId);
	}

	private observeNote(path: string, docId: string): void {
		if (this.noteObservers.has(docId)) return;
		const { doc } = this.docs.note(docId);
		const content = doc.getText(CONTENT);
		const observer = () => {
			void this.enqueue(async () => {
				const current = this.docs.tree().pathFor(docId) ?? path;
				const text = textOf(content);
				if ((await this.files.read(current)) !== text) {
					await this.files.write(current, text);
				}
			});
		};
		content.observe(observer);
		this.noteObservers.set(docId, () => content.unobserve(observer));
	}

	private unobserveNote(docId: string): void {
		this.noteObservers.get(docId)?.();
		this.noteObservers.delete(docId);
	}
}

/**
 * Bring a Y.Text from `oldText` to `newText` as one minimal splice.
 * Indices are UTF-16 code units, which is what both JS strings and Y.Text
 * count, so the boundary arithmetic is one system end to end.
 */
export function splice(content: Y.Text, oldText: string, newText: string, doc: Y.Doc): void {
	if (oldText === newText) return;
	let prefix = 0;
	const limit = Math.min(oldText.length, newText.length);
	while (prefix < limit && oldText[prefix] === newText[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < limit - prefix &&
		oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
	) {
		suffix++;
	}
	doc.transact(() => {
		const deleteLen = oldText.length - prefix - suffix;
		if (deleteLen > 0) content.delete(prefix, deleteLen);
		const middle = newText.slice(prefix, newText.length - suffix);
		if (middle) content.insert(prefix, middle);
	});
}
