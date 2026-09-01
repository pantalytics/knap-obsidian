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
 * - A note's document is borrowed and handed back, never held. Only the tree
 *   and the notes an editor has open keep a socket of their own, and every
 *   other note takes its turn in a small pool, because a browser has 255
 *   sockets and a vault has thousands of notes (issue #115). The cost is
 *   real and worth writing down: a note nobody has open here stops hearing
 *   somebody else's edit the moment it arrives, and catches up the next time
 *   this binding reconciles or the next time anything touches that note.
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

/** One note's document, for as long as somebody is holding it. */
export interface NoteDoc {
	doc: Y.Doc;
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
	/**
	 * Borrow one note's document for the length of `use`.
	 *
	 * A borrow rather than a getter, because a note's socket is not this
	 * binding's to keep: there are 255 of them per Obsidian and thousands of
	 * notes in a vault (issue #115). What the caller is promised is a
	 * document that has synced before `use` runs and a socket that stays up
	 * until everything `use` wrote has left the process. Whoever hands one
	 * over decides when it closes after that.
	 */
	withNote<T>(docId: string, use: (note: NoteDoc) => Promise<T>): Promise<T>;
	/**
	 * Told when a note's document goes down, so this binding can stop
	 * watching a document that will never change again.
	 */
	onNoteClosed(callback: (docId: string) => void): () => void;
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

/**
 * Notes still to move, by direction, with edits deliberately absent.
 *
 * Three things move notes and only two of them can be counted (ADR-0088).
 * `up` is notes this device holds that the cloud vault has not got yet, `down`
 * is notes the cloud vault lists that have no file here. They are disjoint
 * sets, which is what makes them addable: a note is missing from one side or
 * the other, never both.
 *
 * An edit to a note both sides already have is the third thing, and it is not
 * in here. It has no denominator, it is over in under a second, and a number
 * beside the icon that goes 1, 0, 1, 0 while somebody types is what makes the
 * corner of the window unreadable.
 */
export interface Backlog {
	up: number;
	down: number;
}

const CONTENT = "content";

/** How long to wait for the tree's first sync before giving up on a link. */
const TREE_SYNC_TIMEOUT_MS = 30_000;

/**
 * How many notes a fill works on at once.
 *
 * One at a time is one round trip at a time, and a vault of a few thousand
 * notes would still be arriving tomorrow. This is a queue width and not a
 * socket count: how many sockets exist is the client's business, and it caps
 * them at the same number, so a note that finds the pool full waits for a
 * turn instead of opening the 256th socket Chromium never answers.
 */
const FILL_WIDTH = 8;

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
	private stopNoteCloses: (() => void) | null = null;
	private noteObservers = new Map<string, () => void>();
	private queue: Promise<void> = Promise.resolve();
	private failures = 0;
	/** Work taken on and not finished, by direction. Never edits. */
	private outstanding = { up: 0, down: 0 };
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
		// Before anything opens a document: a note whose socket the client
		// closed is a note this binding may not go on watching, and the entry
		// has to go too, or the next borrow of that note finds itself already
		// watched and nothing observes the document that replaced it.
		this.stopNoteCloses = this.docs.onNoteClosed((docId) => this.unobserveNote(docId));
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
					// A document this binding already watches is the echo of
					// its own push coming back through the tree, not a note
					// arriving from somewhere else, and putting it on the
					// down gauge would count every upload twice.
					if (this.noteObservers.has(docId)) {
						await this.bindNote(path, docId);
					} else {
						await this.carry("down", () => this.bindNote(path, docId));
					}
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
		this.stopNoteCloses?.();
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
	 * Notes still to move, by direction.
	 *
	 * Counted where the work is decided rather than where it runs: a fill
	 * works eight notes at a time, so a gauge that went up as each one started
	 * would say eight over a vault of three thousand. What is wanted is how
	 * many are still to come, so the whole set is counted the moment it is
	 * known and each note takes itself off as it lands.
	 */
	get backlog(): Backlog {
		return { ...this.outstanding };
	}

	/** Run `work`, with this note on the gauge for as long as it takes. */
	private async carry<T>(kind: "up" | "down", work: () => Promise<T>): Promise<T> {
		this.outstanding[kind] += 1;
		try {
			return await work();
		} finally {
			this.outstanding[kind] -= 1;
		}
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
		await this.docs.withNote(docId, async ({ doc }) => {
			const text = textOf(doc.getText(CONTENT));
			const at = tree.pathFor(docId) ?? path;
			if ((await this.files.read(at)) !== text) {
				await this.files.write(at, text);
			}
		});
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

		// The work is sorted before any of it runs, because the gauge the
		// corner of the window reads is how many notes are still to move, and
		// the waves below only ever know about eight at a time.
		const gone: string[] = [];
		const up: string[] = [];
		for (const path of local) {
			if (remote.has(path)) continue;
			// In the tree when this device last looked and not now: deleted in
			// the cloud vault while this device was away. A delete is a delete,
			// in both directions.
			(seen.has(path) ? gone : up).push(path);
		}
		const bind: [string, string][] = [];
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
			bind.push([path, docId]);
		}
		// A note the tree lists that is already on the disk is a bind, not a
		// download: it opens the document and writes nothing. Counting those
		// would put the whole vault on the gauge at every start.
		const down = new Set(bind.filter(([path]) => !local.has(path)).map(([path]) => path));
		this.outstanding.up += up.length;
		this.outstanding.down += down.size;

		// Each half runs several notes deep. The tree above is read first and
		// in full, so what each note does is its own business and the width
		// only decides how many are waiting for a socket at once.
		await this.inWaves(gone, (path) => this.files.remove(path));
		await this.inWaves(up, async (path) => {
			try {
				await this.pushNote(path);
			} finally {
				this.outstanding.up -= 1;
			}
		});
		await this.inWaves(bind, async ([path, docId]) => {
			try {
				await this.bindNote(path, docId);
			} finally {
				if (down.has(path)) this.outstanding.down -= 1;
			}
		});
	}

	/**
	 * Run `work` over `items`, a few at a time, counting what fails instead
	 * of stopping.
	 *
	 * One note that cannot be reached is one note, not a link that failed.
	 * The file it came from is still on the disk, the next start tries it
	 * again, and the count is what puts Problem on the screen in the
	 * meantime. A fill of a few thousand notes that gave up on the first
	 * refusal is how somebody ends up restarting Obsidian to make progress.
	 */
	private async inWaves<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < items.length) {
				const item = items[next++];
				try {
					await work(item);
				} catch {
					this.failures += 1;
				}
			}
		};
		const width = Math.max(1, Math.min(FILL_WIDTH, items.length));
		await Promise.all(Array.from({ length: width }, () => worker()));
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
			await this.pushCounted(event.path);
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
		await this.pushCounted(event.path);
	}

	/**
	 * Push, and put it on the gauge only when it is a note going up for the
	 * first time. A path the tree already knows is an edit, and an edit is
	 * never counted (ADR-0088).
	 */
	private async pushCounted(path: string): Promise<void> {
		if (this.docs.tree().docIdFor(normalize(path)) !== undefined) {
			return this.pushNote(path);
		}
		return this.carry("up", () => this.pushNote(path));
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
		await this.docs.withNote(docId, async ({ doc }) => {
			const content = doc.getText(CONTENT);
			if (textOf(content) !== text) {
				splice(content, textOf(content), text, doc);
			}
			this.observeNote(clean, docId, content);
		});
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
		const copy = await this.docs.withNote(docId, async ({ doc }) => {
			const content = doc.getText(CONTENT);
			const docText = textOf(content);
			const fileText = await this.files.read(path);
			let conflict: string | null = null;

			if (fileText === null) {
				await this.files.write(path, docText);
			} else if (fileText !== docText) {
				if (docText === "") {
					// A minted note nobody typed in yet: the local text is the
					// note. A note somebody deliberately emptied looks exactly
					// the same from here and nothing can tell them apart, so
					// this goes the way that cannot lose anything.
					splice(content, "", fileText, doc);
				} else {
					// Both sides wrote. The cloud text wins the path; the local
					// text survives beside it, named for what happened.
					conflict = buildConflictCopyPath(path, this.conflictLabel());
					await this.files.write(conflict, fileText);
					await this.files.write(path, docText);
				}
			}
			this.observeNote(path, docId, content);
			return conflict;
		});
		// The copy is a note of its own and needs a document of its own, so it
		// is pushed after this note has handed its socket back rather than
		// from inside: a borrow that waits on a second borrow is how a pool
		// this small deadlocks. Explicitly, because this can run before the
		// event stream is on.
		if (copy) await this.pushNote(copy);
	}

	/**
	 * Follow one note's document for as long as it stays open.
	 *
	 * The text is read the moment the change arrives rather than when the
	 * write comes up in the queue, because by then the document may have been
	 * handed back and closed. What was observed is what gets written, and a
	 * second change writes again, so the last one still wins.
	 */
	private observeNote(path: string, docId: string, content: Y.Text): void {
		if (this.noteObservers.has(docId)) return;
		const observer = () => {
			const text = textOf(content);
			void this.enqueue(async () => {
				const current = this.docs.tree().pathFor(docId) ?? path;
				// An open editor already has this change and owns the file.
				if (this.held.has(current)) return;
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
