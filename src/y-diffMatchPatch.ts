import * as Y from "yjs";
import { curryLog } from "./debug";
import { diff_match_patch, type Diff } from "diff-match-patch";
import { flags } from "./flagManager";

// diff-match-patch exposes these only as statics on the class; the operation
// values themselves are part of its wire format and are stable.
const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

function endsWithHighSurrogate(text: string): boolean {
	if (!text) return false;
	const c = text.charCodeAt(text.length - 1);
	return c >= HIGH_SURROGATE_MIN && c <= HIGH_SURROGATE_MAX;
}

function startsWithLowSurrogate(text: string): boolean {
	if (!text) return false;
	const c = text.charCodeAt(0);
	return c >= LOW_SURROGATE_MIN && c <= LOW_SURROGATE_MAX;
}

/**
 * `diff_main` works in UTF-16 code units, so it is free to put a diff boundary
 * between the two halves of a surrogate pair. Two emoji that share a high
 * surrogate (🍎 = D83C DF4E and 🍊 = D83C DF4A) produce EQUAL "\uD83C",
 * DELETE "\uDF4E", INSERT "\uDF4A" — applying that verbatim leaves lone
 * surrogates in the Y.Text, which is no longer well-formed UTF-16 and is
 * unrecoverable once broadcast as a CRDT op.
 *
 * Both inputs are well-formed, so a split can only happen where both sides
 * share the pair — i.e. across an EQUAL boundary. Move the shared half out of
 * the EQUAL segment and onto both the delete and the insert side, so the code
 * point is replaced as a whole rather than patched in halves.
 */
export function alignDiffsToCodePoints(diffs: Diff[]): Diff[] {
	const out: Diff[] = diffs.map(([op, text]) => [op, text] as Diff);

	for (let i = 0; i < out.length - 1; i++) {
		if (out[i][0] !== DIFF_EQUAL) continue;
		if (!endsWithHighSurrogate(out[i][1])) continue;

		// Only a real split if what follows starts with the matching low half.
		const followers = out.slice(i + 1, i + 3);
		if (!followers.some(([, text]) => startsWithLowSurrogate(text))) continue;

		const high = out[i][1].slice(-1);
		out[i][1] = out[i][1].slice(0, -1);
		moveHalfOntoBothSides(out, i + 1, high);
	}

	for (let i = 1; i < out.length; i++) {
		if (out[i][0] !== DIFF_EQUAL) continue;
		if (!startsWithLowSurrogate(out[i][1])) continue;

		const predecessors = out.slice(Math.max(0, i - 2), i);
		if (!predecessors.some(([, text]) => endsWithHighSurrogate(text))) continue;

		const low = out[i][1].slice(0, 1);
		out[i][1] = out[i][1].slice(1);
		appendHalfToBothSides(out, i - 1, low);
	}

	return out.filter(([, text]) => text.length > 0);
}

/**
 * Prepend `half` to the delete side and the insert side of the non-equal run
 * starting at `start`, creating whichever side is missing. Keeping both sides
 * in step is what preserves the diff invariant: EQUAL+DELETE must still spell
 * the old text and EQUAL+INSERT the new one.
 */
function moveHalfOntoBothSides(diffs: Diff[], start: number, half: string) {
	let sawDelete = false;
	let sawInsert = false;
	let end = start;
	while (end < diffs.length && diffs[end][0] !== DIFF_EQUAL) {
		if (diffs[end][0] === DIFF_DELETE && !sawDelete) {
			diffs[end][1] = half + diffs[end][1];
			sawDelete = true;
		} else if (diffs[end][0] === DIFF_INSERT && !sawInsert) {
			diffs[end][1] = half + diffs[end][1];
			sawInsert = true;
		}
		end++;
	}
	if (!sawDelete) diffs.splice(start, 0, [DIFF_DELETE, half]);
	if (!sawInsert) diffs.splice(start, 0, [DIFF_INSERT, half]);
}

function appendHalfToBothSides(diffs: Diff[], end: number, half: string) {
	let sawDelete = false;
	let sawInsert = false;
	let start = end;
	while (start >= 0 && diffs[start][0] !== DIFF_EQUAL) {
		if (diffs[start][0] === DIFF_DELETE && !sawDelete) {
			diffs[start][1] = diffs[start][1] + half;
			sawDelete = true;
		} else if (diffs[start][0] === DIFF_INSERT && !sawInsert) {
			diffs[start][1] = diffs[start][1] + half;
			sawInsert = true;
		}
		start--;
	}
	if (!sawDelete) diffs.splice(end + 1, 0, [DIFF_DELETE, half]);
	if (!sawInsert) diffs.splice(end + 1, 0, [DIFF_INSERT, half]);
}

export function diffMatchPatch(
	ydoc: Y.Doc,
	diskBuffer: string,
	origin?: unknown,
): void {
	// Get the YText from the YDoc
	const ytext = ydoc.getText("contents");

	// Get the current content of the YText
	const currentContent = ytext.toJSON();

	// Create a new diff_match_patch object
	const dmp = new diff_match_patch();

	// Compute the diff between the current content and the disk buffer
	const rawDiffs: Diff[] = dmp.diff_main(currentContent, diskBuffer);

	// Optimize the diff
	dmp.diff_cleanupSemantic(rawDiffs);

	// Never let a diff boundary land inside a surrogate pair.
	const diffs = alignDiffsToCodePoints(rawDiffs);

	// Initialize the cursor position
	let cursor = 0;

	const log = flags().enableDeltaLogging
		? curryLog("[diffMatchPatch]", "debug")
		: (...args: unknown[]) => {};

	// Log the overall change
	log("Updating YDoc:");
	log("Current content length:", currentContent.length);
	log("Disk buffer length:", diskBuffer.length);

	if (diffs.length == 0) {
		return;
	}

	// Apply the diffs as updates to the YDoc
	ydoc.transact(() => {
		for (const [operation, text] of diffs) {
			switch (operation) {
				case 1: // Insert
					log(`Inserting "${text}" at position ${cursor}`);
					ytext.insert(cursor, text);
					cursor += text.length;
					break;
				case 0: // Equal
					log(`Keeping "${text}" (length: ${text.length})`);
					cursor += text.length;
					break;
				case -1: // Delete
					log(`Deleting "${text}" at position ${cursor}`);
					ytext.delete(cursor, text.length);
					break;
			}
			log("intermediate", ytext.toJSON());
		}

		// Backstop: applying a diff must land exactly on `diskBuffer`. If it
		// ever doesn't, the Y.Text now holds text nobody wrote — worse than a
		// coarse repair, because it is broadcast as a genuine edit and cannot
		// be told apart from one afterwards. Repair inside the same transaction
		// so no observer ever sees the bad intermediate state, and keep the
		// repair minimal by only replacing the span that actually differs.
		const applied = ytext.toJSON();
		if (applied !== diskBuffer) {
			log("Diff did not land on the target — repairing", {
				appliedLength: applied.length,
				targetLength: diskBuffer.length,
			});
			replaceDivergentSpan(ytext, applied, diskBuffer);
		}
	}, origin);

	log("result", ytext.toJSON());

	// Log the final state
	log("Update complete. New content length:", ytext.toJSON().length);
}

/**
 * Rewrite the smallest span that differs between `applied` and `target`,
 * trimming the shared prefix and suffix back to code point boundaries so the
 * repair can never introduce the very splitting it exists to undo.
 */
function replaceDivergentSpan(
	ytext: Y.Text,
	applied: string,
	target: string,
): void {
	let prefix = 0;
	const maxPrefix = Math.min(applied.length, target.length);
	while (prefix < maxPrefix && applied[prefix] === target[prefix]) prefix++;
	// Don't cut between the halves of a pair we are keeping.
	if (prefix > 0 && endsWithHighSurrogate(applied.slice(0, prefix))) prefix--;

	let suffix = 0;
	const maxSuffix = Math.min(applied.length - prefix, target.length - prefix);
	while (
		suffix < maxSuffix &&
		applied[applied.length - 1 - suffix] === target[target.length - 1 - suffix]
	)
		suffix++;
	if (suffix > 0 && startsWithLowSurrogate(applied.slice(applied.length - suffix)))
		suffix--;

	const deleteLength = applied.length - prefix - suffix;
	if (deleteLength > 0) {
		ytext.delete(prefix, deleteLength);
	}
	const insertText = target.slice(prefix, target.length - suffix);
	if (insertText) {
		ytext.insert(prefix, insertText);
	}
}

/**
 * Persists `content` somewhere the user can find it and returns the path it
 * was written to. Injected by the caller so this module stays independent of
 * the vault/file API (and directly unit-testable without mocking it).
 */
export type ConflictCopyWriter = (content: string) => Promise<string>;

export interface ReconcileResult {
	/** True if the Y.Doc was rewritten to match `vaultContent`. */
	reconciled: boolean;
	/** Path the pre-reconciliation content was preserved at, if it diverged. */
	conflictPath?: string;
}

/**
 * Reconcile a Y.Doc's "contents" text to match `vaultContent`, WITHOUT
 * silently discarding whatever the Y.Doc currently holds (TR-01, #814d6d9b).
 *
 * `diffMatchPatch` computes a plain-text diff against whatever is CURRENTLY
 * in the Y.Doc and applies it as real delete/insert CRDT ops — indistinguishable
 * from any other edit once broadcast, and unrecoverable after GC. If the Y.Doc's
 * content differs from `vaultContent` at all, the losing (pre-reconciliation)
 * content is preserved via `writeConflictCopy` FIRST. If that write fails, the
 * reconciliation is skipped entirely (fail closed) rather than risk a silent loss.
 */
export async function reconcileWithConflictCopy(
	ydoc: Y.Doc,
	vaultContent: string,
	writeConflictCopy: ConflictCopyWriter,
	origin?: unknown,
	log: (...args: unknown[]) => void = () => {},
): Promise<ReconcileResult> {
	const ytext = ydoc.getText("contents");
	const currentContent = ytext.toJSON();

	if (currentContent === vaultContent) {
		return { reconciled: false };
	}

	let conflictPath: string;
	try {
		conflictPath = await writeConflictCopy(currentContent);
	} catch (e) {
		log(
			"Failed to write conflict copy — skipping reconciliation to avoid silent data loss:",
			e,
		);
		return { reconciled: false };
	}

	diffMatchPatch(ydoc, vaultContent, origin);
	return { reconciled: true, conflictPath };
}
