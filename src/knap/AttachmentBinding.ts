/**
 * The other binding: local files that are not notes, and their bytes.
 *
 * `VaultBinding` is the engine for notes, and it is built around the one
 * thing notes are: text that merges. An attachment is the opposite. A PNG
 * has no common prefix worth keeping, no splice that means anything, and no
 * document at all: its bytes go over the file routes and the tree records
 * only that it exists, at `{hash, size}` (ADR-0078). Two engines, because
 * one engine with a branch in every method is two engines wearing a coat.
 *
 * The rules, and they rhyme with the note ones on purpose:
 *
 * - The hash is the whole of "do I already have this". Every direction
 *   compares it before moving a byte, which is what makes both directions
 *   idempotent and what kills the echo loop: Obsidian fires an event for
 *   this binding's own writes, and the push it triggers finds the hash
 *   already recorded and stops.
 * - The bytes go up before the entry does. An entry is what tells every
 *   other device to come and fetch, so writing it first sends them after
 *   bytes that are not there yet.
 * - A file over the ceiling is refused here, with a sentence, rather than
 *   uploaded and refused there with a 413. The server refuses it either way;
 *   this is about not spending somebody's upstream first.
 * - Two devices that wrote different bytes to one path keep both: the cloud
 *   copy takes the path and the local copy survives beside it, named for
 *   what happened. That is the note rule, and an attachment deserves it
 *   more, not less, because there is no text to reconstruct it from.
 */

import { buildConflictCopyPath } from "../conflictCopyPath";
import { generateHash } from "../hashing";
import type { AttachmentEntry, TreeDoc } from "./TreeDoc";
import { isHidden, isNote, normalize } from "./TreeDoc";
import type { Backlog, FileEvent, FileStore } from "./VaultBinding";

/** What the binding needs from the file routes. KnapServer satisfies it. */
export interface AttachmentTransport {
	upload(path: string, content: ArrayBuffer): Promise<{ sha256: string; size: number }>;
	download(path: string): Promise<ArrayBuffer>;
	remove(path: string): Promise<void>;
	/** What this deployment accepts. Asked once, at link time. */
	limits(): Promise<AttachmentLimits>;
}

export interface AttachmentLimits {
	maxAttachmentBytes: number;
	maxVaultBytes: number;
}

/** What the binding needs from the tree. KnapVaultClient's TreeDoc satisfies it. */
export interface AttachmentDocs {
	tree(): TreeDoc;
	treeSynced(): Promise<void>;
}

/**
 * Told when a file cannot travel, so a screen can say so. The path is in it
 * because this reaches the person whose file it is, on their own device;
 * ADR-0071 governs what leaves the device, and nothing here does.
 */
export type Refusal = (path: string, reason: string) => void;

/** How long to wait for the tree's first sync before giving up on a link. */
const TREE_SYNC_TIMEOUT_MS = 30_000;

/**
 * What a deployment accepts, when it could not be asked. Deliberately the
 * server's own default rather than Infinity: a link that came up while
 * `/api/limits` was down should still refuse a 2 GB file locally instead of
 * pushing it at a server that will refuse it anyway.
 */
export const FALLBACK_LIMITS: AttachmentLimits = {
	maxAttachmentBytes: 100 * 1024 * 1024,
	maxVaultBytes: 10 * 1024 * 1024 * 1024,
};

export class AttachmentBinding {
	private stopFileEvents: (() => void) | null = null;
	private stopTreeEvents: (() => void) | null = null;
	private queue: Promise<void> = Promise.resolve();
	private limits: AttachmentLimits = FALLBACK_LIMITS;
	/** Files still to move, by direction. The note half keeps the same two. */
	private outstanding = { up: 0, down: 0 };

	constructor(
		private readonly files: FileStore,
		private readonly docs: AttachmentDocs,
		private readonly transport: AttachmentTransport,
		private readonly refused: Refusal = () => undefined,
		private readonly conflictLabel = () => `conflict ${new Date().toISOString().slice(0, 10)}`,
	) {}

	async start(): Promise<void> {
		try {
			this.limits = await this.transport.limits();
		} catch {
			// A link that cannot read the ceilings is still a link. The
			// server enforces them regardless, so the cost of guessing here
			// is one wasted upload, not a wrong outcome.
			this.limits = FALLBACK_LIMITS;
		}
		await this.enqueue(() => this.reconcileAll());
		this.stopFileEvents = this.files.onChange((event) => {
			if (isNote(event.path)) return; // VaultBinding's half
			// Obsidian's own settings and plugins are not the vault's
			// contents, and the server refuses them anyway (ADR-0067). Quiet
			// rather than refused: the person did not put these here.
			if (isHidden(event.path)) return;
			void this.enqueue(() => this.onFileEvent(event));
		});
		this.stopTreeEvents = this.docs.tree().onAttachmentChange((change) => {
			void this.enqueue(async () => {
				for (const [path, entry] of change.added) {
					// An attachment this device already has is the echo of its
					// own upload arriving back through the tree.
					const here = (await this.files.readBinary(path)) !== null;
					if (here) await this.pull(path, entry);
					else await this.carry("down", () => this.pull(path, entry));
				}
				for (const [path] of change.removed) {
					// A path in both halves is an attachment whose bytes
					// changed, not one that left. Removing the file there
					// would delete what the added half just fetched.
					if (!change.added.has(path)) {
						await this.files.remove(path);
					}
				}
			});
		});
	}

	stop(): void {
		this.stopFileEvents?.();
		this.stopTreeEvents?.();
		this.stopFileEvents = null;
		this.stopTreeEvents = null;
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

	/**
	 * Attachments still to move, by direction.
	 *
	 * Kept apart from the notes rather than added to them because the two
	 * behave differently on a slow line: one photo is a hundred notes' worth
	 * of bytes, so a single number would sit still for a minute and then jump.
	 * The corner adds them anyway; the screen behind it is where the four
	 * numbers are worth having separately (ADR-0086).
	 */
	get backlog(): Backlog {
		return { ...this.outstanding };
	}

	/** Run `work`, with this file on the gauge for as long as it takes. */
	private async carry<T>(kind: "up" | "down", work: () => Promise<T>): Promise<T> {
		this.outstanding[kind] += 1;
		try {
			return await work();
		} finally {
			this.outstanding[kind] -= 1;
		}
	}

	private async reconcileAll(): Promise<void> {
		// The same wait the note half makes, and for the same reason: a
		// device that reconciled against an empty tree would decide every
		// attachment in the cloud was missing and upload its own copies over
		// them.
		await withTimeout(
			this.docs.treeSynced(),
			TREE_SYNC_TIMEOUT_MS,
			"Could not reach the server. Nothing was changed; try again.",
		);
		const tree = this.docs.tree();
		const recorded = tree.attachments();
		const local = new Set((await this.files.listAttachments()).map(normalize));
		// Sorted before any of it runs, so the gauge says how many files are
		// still to come rather than how many are in flight right now.
		const up = [...local].filter((path) => !recorded.has(path) && !isHidden(path));
		// A recorded attachment already on the disk is checked, not fetched.
		// Whether the bytes match is `pull`'s business and costs a hash; what
		// the gauge needs is the file that is plainly not here.
		const arriving = new Set(
			[...recorded].filter(([path]) => !local.has(path)).map(([path]) => path),
		);
		this.outstanding.up += up.length;
		this.outstanding.down += arriving.size;
		for (const path of up) {
			try {
				await this.push(path);
			} finally {
				this.outstanding.up -= 1;
			}
		}
		for (const [path, entry] of recorded) {
			try {
				await this.pull(path, entry);
			} finally {
				if (arriving.has(path)) this.outstanding.down -= 1;
			}
		}
	}

	// -- local to remote ------------------------------------------------------

	private async onFileEvent(event: FileEvent): Promise<void> {
		if (event.type === "rename" && event.oldPath) {
			await this.onRename(normalize(event.oldPath), normalize(event.path));
			return;
		}
		if (event.type === "delete") {
			await this.forget(normalize(event.path));
			return;
		}
		// New bytes or replaced bytes, both going up, and unlike a note there
		// is no cheap way to tell an edit from a first upload: an attachment is
		// replaced whole. Both are counted, which is honest, because both take
		// as long as the file is big.
		await this.carry("up", () => this.push(event.path));
	}

	/**
	 * Take one local file to the cloud, if the cloud does not already have
	 * exactly it.
	 */
	private async push(path: string): Promise<void> {
		const clean = normalize(path);
		const content = await this.files.readBinary(clean);
		if (content === null) return; // gone again before we got to it

		if (content.byteLength > this.limits.maxAttachmentBytes) {
			this.refused(
				clean,
				`This file is ${readable(content.byteLength)}, and the cloud vault takes ` +
					`attachments up to ${readable(this.limits.maxAttachmentBytes)}. ` +
					"It stays on this device.",
			);
			return;
		}

		const hash = await generateHash(content);
		const tree = this.docs.tree();
		// The idempotent check, and the one that breaks the echo: a write
		// this binding made itself comes back as a file event, and lands here
		// with the hash already recorded.
		if (tree.attachmentFor(clean)?.hash === hash) return;

		try {
			await this.transport.upload(clean, content);
		} catch (error) {
			this.refused(clean, messageOf(error));
			return;
		}
		// Only now, because this entry is what sends every other device
		// after the bytes.
		tree.setAttachment(clean, { hash, size: content.byteLength });
	}

	private async onRename(from: string, to: string): Promise<void> {
		const tree = this.docs.tree();
		if (tree.attachmentFor(from) === undefined) {
			// Never ours, or renamed before it was ever pushed. Either way
			// the new path is what counts.
			await this.push(to);
			return;
		}
		// The server keys an attachment by its vault path, so unlike a note's
		// rename this one moves bytes. Upload first: an entry pointing at a
		// path with nothing behind it is worse than a moment of two copies.
		const content = await this.files.readBinary(to);
		if (content === null) {
			// Renamed and then gone. Nothing to carry over.
			await this.forget(from);
			return;
		}
		try {
			await this.transport.upload(to, content);
		} catch (error) {
			this.refused(to, messageOf(error));
			return;
		}
		tree.moveAttachment(from, to);
		await this.removeQuietly(from);
	}

	/**
	 * A local delete: the entry goes, and the bytes follow it.
	 *
	 * The path may be a folder rather than a file. Obsidian's delete names
	 * the folder and not what was in it, so the attachments underneath have
	 * to be found here or they stay in the map and come back down onto the
	 * disk they were just deleted from.
	 */
	private async forget(path: string): Promise<void> {
		const tree = this.docs.tree();
		if (tree.removeAttachment(path)) {
			await this.removeQuietly(path);
			return;
		}
		for (const gone of tree.removeAttachmentsUnder(path)) {
			await this.removeQuietly(gone);
		}
	}

	// -- remote to local ------------------------------------------------------

	/**
	 * Bring one attachment down, unless this device already has those exact
	 * bytes, and never over something different without keeping it.
	 */
	private async pull(path: string, entry: AttachmentEntry): Promise<void> {
		const local = await this.files.readBinary(path);
		if (local !== null) {
			if ((await generateHash(local)) === entry.hash) return; // already here
			// Both sides have bytes, and they differ. There is no merge for a
			// binary and no text to rebuild it from, so nothing is thrown
			// away: the cloud copy takes the path and this device's copy
			// survives beside it, named for what happened.
			const copy = buildConflictCopyPath(path, this.conflictLabel());
			await this.files.writeBinary(copy, local);
			await this.push(copy);
		}
		let content: ArrayBuffer;
		try {
			content = await this.transport.download(path);
		} catch (error) {
			this.refused(path, messageOf(error));
			return;
		}
		await this.files.writeBinary(path, content);
	}

	/**
	 * Delete the bytes, and let a delete that was already done pass. Another
	 * device removing the same attachment first is the ordinary case in a
	 * vault with two people in it, not a failure worth a sentence on screen.
	 */
	private async removeQuietly(path: string): Promise<void> {
		try {
			await this.transport.remove(path);
		} catch (error) {
			this.refused(path, messageOf(error));
		}
	}
}

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

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Bytes as a person reads them. The server's refusals use the same shape. */
export function readable(size: number): string {
	const units = ["bytes", "KB", "MB", "GB"];
	let value = size;
	for (const unit of units) {
		if (value < 1024 || unit === "GB") {
			return unit === "bytes" ? `${Math.round(value)} bytes` : `${value.toFixed(1)} ${unit}`;
		}
		value /= 1024;
	}
	return `${value.toFixed(1)} GB`;
}
