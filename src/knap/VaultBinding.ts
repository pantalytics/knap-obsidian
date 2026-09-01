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
 * - A note deleted here is deleted in the cloud vault, and the other way
 *   round, whether or not the plugin was running when it happened. That is
 *   what the `SeenTree` is for: without a record of what this device last
 *   agreed with, a missing file and a note that never arrived look the
 *   same, and every restart undid both sides\' deletes.
 */

import * as Y from "yjs";

import { buildConflictCopyPath } from "../conflictCopyPath";
import { TreeDoc, isNote, normalize } from "./TreeDoc";

export interface FileEvent {
	type: "create" | "modify" | "delete" | "rename";
	path: string;
	oldPath?: string;
}

/**
 * What the two bindings need from a vault's files. Obsidian adapts to this.
 *
 * Text and bytes are separate methods rather than one that guesses, because
 * the two callers are separate engines: `VaultBinding` reads a note as a
 * string it can splice, `AttachmentBinding` reads a PNG as bytes it can
 * hash. `onChange` reports every file, notes and attachments alike, and each
 * binding ignores the half that is not its own.
 */
export interface FileStore {
	read(path: string): Promise<string | null>;
	write(path: string, text: string): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer | null>;
	writeBinary(path: string, content: ArrayBuffer): Promise<void>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	listNotes(): Promise<string[]>;
	/** Every file in the vault that is not a note. */
	listAttachments(): Promise<string[]>;
	onChange(callback: (event: FileEvent) => void): () => void;
}

/** What the binding needs from the wire. KnapVaultClient satisfies it. */
export interface VaultDocs {
	tree(): TreeDoc;
	/**
	 * Resolves once the tree has had its first sync with the server.
	 *
	 * Opening the tree's socket hands back a document immediately, and for a
	 * moment that document is empty. Reconciling against it is how a note
	 * that already exists in the cloud gets a second document minted for it.
	 */
	treeSynced(): Promise<void>;
	note(docId: string): { doc: Y.Doc; synced: Promise<void> };
}

/**
 * What this device last agreed with: path -> document id, as the tree read
 * the moment the binding had finished applying it to the disk.
 *
 * It is the base of a three-way comparison, and it is the only thing that
 * can tell a note somebody deleted here from a note that has not arrived
 * yet. A device that has none behaves the way linking always has: nothing
 * is deleted on either side, both sides merge.
 *
 * Per cloud vault, and local to the device. `forget` is what unlink and
 * sign out call, so a later relink starts from no memory and keeps their
 * promise that nothing is deleted anywhere.
 */
export interface SeenTree {
	load(): Promise<Map<string, string>>;
	save(entries: Map<string, string>): Promise<void>;
	forget(): Promise<void>;
}

const CONTENT = "content";

/** How long to wait for the tree's first sync before giving up on a link. */
const TREE_SYNC_TIMEOUT_MS = 30_000;

/** Reject with `message` if `promise` has not settled in `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

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
	private failures = 0;
	/** Paths an open editor is holding, which this binding leaves alone. */
	private held = new Set<string>();
	/** Set whenever this device changed the tree, cleared when it is saved. */
	private seenDirty = false;

	constructor(
		private readonly files: FileStore,
		private readonly docs: VaultDocs,
		private readonly conflictLabel = () => `conflict ${new Date().toISOString().slice(0, 10)}`,
		private readonly seen: SeenTree | null = null,
	) {}

	/**
	 * Link: reconcile both sides once, then follow both event streams.
	 * Everything runs through one queue, so a burst of events cannot
	 * interleave two half-finished reconciliations.
	 */
	async start(): Promise<void> {
		await this.enqueue(() => this.reconcileAll());
		this.stopFileEvents = this.files.onChange((event) => {
			// The store reports both kinds, and each binding takes its own.
			// A delete is the exception and may not be filtered on the path:
			// deleting a folder names the folder, not the notes in it, so a
			// filter that let only `.md` through would drop the one event
			// that takes those notes out of the tree.
			if (!isNote(event.path) && event.type !== "delete") return;
			void this.enqueue(() => this.onFileEvent(event));
		});
		this.stopTreeEvents = this.docs.tree().onChange((change) => {
			void this.enqueue(async () => {
				this.seenDirty = true;
				for (const [path, docId] of change.added) {
					await this.bindNote(path, docId);
				}
				for (const [path, docId] of change.removed) {
					// A move announces itself as removed+added under one id, and
					// the added half above already wrote the new file, so the old
					// path goes either way. Only a note that left the tree for
					// good stops being watched.
					//
					// A path in both halves is not a departure: it is the same
					// note pointed at a different document. Removing the file
					// there deletes a note nobody deleted, and the delete event
					// that follows takes the path out of the tree on every
					// device. Measured on production 2026-08-31.
					if (!change.added.has(path)) {
						await this.files.remove(path);
					}
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

	/**
	 * How many pieces of work failed since this binding started.
	 *
	 * The status bar needs to be able to say *Problem*, and the only place
	 * that knows a push or a bind went wrong is the queue every one of them
	 * runs through. Counting here rather than at each call site means a new
	 * kind of work is counted the day it is added, without anybody
	 * remembering to.
	 */
	get problems(): number {
		return this.failures;
	}

	/**
	 * Stand down for one note, because an editor is bound to it directly.
	 *
	 * Two writers on one note is one too many. While a note is open,
	 * `LiveNote` puts every keystroke into the document as it is typed and
	 * every remote change into the editor, and Obsidian saves the file the
	 * way it saves any file somebody is typing in. If this binding also
	 * wrote that file it would overwrite the editor's unsaved buffer, and if
	 * it also pushed the file's `modify` events it would splice a copy that
	 * is a save behind, which deletes whatever arrived in the meantime.
	 *
	 * Returns the release, which is also the catch-up: the file may be a
	 * couple of seconds behind the document when the editor lets go, and it
	 * is written from the document once here rather than waiting for the
	 * next change to that note.
	 */
	hold(path: string): () => void {
		const clean = normalize(path);
		this.held.add(clean);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.held.delete(clean);
			void this.enqueue(() => this.writeFromDocument(clean));
		};
	}

	private async writeFromDocument(path: string): Promise<void> {
		const tree = this.docs.tree();
		const docId = tree.docIdFor(path);
		if (!docId) return;
		const { doc } = this.docs.note(docId);
		const text = textOf(doc.getText(CONTENT));
		const at = tree.pathFor(docId) ?? path;
		if ((await this.files.read(at)) !== text) {
			await this.files.write(at, text);
		}
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		const counted = async () => {
			try {
				await work();
			} catch (error) {
				this.failures += 1;
				// Rethrown, not swallowed. The rejection is what keeps
				// rememberTree below off the failure path, and the queue's own
				// handler is what keeps one failure from stopping the next unit.
				throw error;
			}
		};
		// The record is written only where `work` returned: a unit that threw
		// half way leaves the disk and the tree disagreeing, and remembering
		// that as agreed is how the next start deletes what it failed to
		// write. Work still runs on both settle paths, so one failure does
		// not wedge the queue.
		this.queue = this.queue.then(counted, counted).then(() => this.rememberTree());
		return this.queue;
	}

	/** Write down the tree this device now agrees with. Failing is survivable. */
	private async rememberTree(): Promise<void> {
		if (!this.seenDirty || !this.seen) return;
		this.seenDirty = false;
		try {
			await this.seen.save(this.docs.tree().entries());
		} catch {
			// A record that could not be written is a record that stays
			// older than it is, and older is the safe direction: every
			// deletion below needs the record to positively say so.
			this.seenDirty = true;
		}
	}

	// -- link time -----------------------------------------------------------

	private async reconcileAll(): Promise<void> {
		// Wait for the tree before deciding anything is missing from it.
		// Measured on production 2026-08-31: a device that reconciled against
		// an empty tree minted a fresh document for a path that already had
		// one, and the note ended up with two documents and no name.
		//
		// Bounded, because a socket that never syncs would otherwise leave
		// the Link button waiting with nothing on screen. Giving up here is
		// better than reconciling against a tree that never arrived: the
		// caller gets a sentence it can show, and the next start tries again.
		await withTimeout(
			this.docs.treeSynced(),
			TREE_SYNC_TIMEOUT_MS,
			"Could not reach the server. Nothing was changed; try again.",
		);
		const tree = this.docs.tree();
		const local = new Set((await this.files.listNotes()).map(normalize));
		const remote = tree.entries();
		const seen = (await this.seen?.load()) ?? new Map<string, string>();

		// A vault whose files have not been indexed yet reads exactly like a
		// vault somebody emptied, and only one of those two is worth acting
		// on. The plugin starts the binding after the layout is ready for
		// this reason; this is the second lock on the same door, because the
		// cost of being wrong here is every note in the cloud vault.
		const emptied = local.size === 0 && seen.size > 0;

		for (const path of local) {
			if (remote.has(path)) continue;
			if (seen.has(path)) {
				// It was in the tree when this device last looked and it is
				// not now: it was deleted in the cloud vault while this
				// device was away. A delete is a delete, in both directions.
				await this.files.remove(path);
			} else {
				await this.pushNote(path);
			}
		}
		for (const [path, docId] of remote) {
			if (!local.has(path) && !emptied && seen.get(path) === docId) {
				// The same note, at the same path, as this device last had
				// it on disk, and the file is gone. Somebody deleted it here
				// while the plugin was not running. Without the record this
				// downloaded the note back, every time, on every device.
				tree.remove(path);
				this.seenDirty = true;
				continue;
			}
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
				this.seenDirty = true;
				return;
			}
			await this.pushNote(event.path);
			return;
		}
		if (event.type === "delete") {
			const path = normalize(event.path);
			if (!path.endsWith(".md")) {
				// A folder. Obsidian deletes the notes inside it, and the
				// tree has to lose them too, or they come back down onto the
				// disk they were just deleted from.
				for (const docId of tree.removeUnder(path)) {
					this.unobserveNote(docId);
					this.seenDirty = true;
				}
				return;
			}
			const docId = tree.docIdFor(path);
			if (tree.remove(path)) this.seenDirty = true;
			if (docId) this.unobserveNote(docId);
			return;
		}
		// A note an editor is holding writes itself, keystroke by keystroke;
		// the save event that arrives a second later says nothing newer.
		if (this.held.has(normalize(event.path))) return;
		// create and modify converge: bring the document to the file's text.
		await this.pushNote(event.path);
	}

	private async pushNote(path: string): Promise<void> {
		const clean = normalize(path);
		// Belt and braces: the event stream is filtered already, but
		// reconcileAll and the conflict-copy path both call in directly.
		if (!isNote(clean)) return;
		const text = await this.files.read(clean);
		if (text === null) return; // gone again before we got to it

		const tree = this.docs.tree();
		const known = tree.docIdFor(clean);
		const docId = tree.ensureNote(clean);
		if (known === undefined) this.seenDirty = true;
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
				// An open editor already has this change and owns the file.
				if (this.held.has(current)) return;
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
