/**
 * What a write to a note's file means for that note's Y.Text (#81, #82).
 *
 * ADR-0075 in knap-mcp-admin is the decision this module carries out.
 *
 * The old question was "is this note's socket open" -- `!file.connected` in
 * main.ts's modify handler. A socket is a fact about the network, not about the
 * editor, so a note whose socket was open had its disk writes dropped even when
 * nothing had put them into the Y.Text: a Kanban board re-serialised before its
 * view started tracking, an Excalidraw drawing that never gets a view at all.
 * The divergence was then repaired much later by diffing two states no single
 * writer ever held, and every repair left a conflict copy behind.
 *
 * The question this module answers instead is "did this write already reach the
 * Y.Text, and if not, is it safe to put it there". Both halves are answerable on
 * the device, with no relay and no second opinion:
 *
 * - Equal text means the write already landed. Nothing to do, and the two sides
 *   are known to agree, which is worth recording.
 * - A Y.Doc that has not moved since the last moment the two sides agreed means
 *   the file is a pure descendant of what the Y.Text holds. The write is an
 *   edit and it is carried in. Nobody's work is at risk, so no conflict copy.
 * - A Y.Doc that has moved means somebody else's edit arrived in between. That
 *   is the case a conflict copy is for, and it stays on the old route.
 *
 * Pure on purpose: no vault API, no Y.Doc, no Document. Importing any of those
 * drags in the ESM-only `pocketbase` package, which ts-jest will not parse, and
 * this is the half worth testing directly. See `Document.carryDiskWrite` for
 * the side that owns the Y.Text and `conflictCopyPath.ts` for the same split.
 */

export type CarryVerdict = "noop" | "carry" | "reconcile" | "refuse";

export interface CarryDecision {
	verdict: CarryVerdict;
	/**
	 * Why, in a form that is safe to log or report: no path, no note body, no
	 * excerpt of one. ADR-0071 in knap-mcp-admin is the rule.
	 */
	reason: string;
}

export interface CarryInput {
	/** What the note's Y.Text holds right now. */
	crdtText: string;
	/** What has just been written to the note's file. */
	diskText: string;
	/**
	 * True when the Y.Doc has not moved since the last moment the file and the
	 * Y.Text were known to hold the same text. False when it has moved, and
	 * false when there is no such moment on record yet -- an unknown answer is
	 * the same as a bad one here, because both mean the file cannot be shown to
	 * be a descendant.
	 */
	crdtHeldStill: boolean;
}

/** A note opens with frontmatter when its first line is exactly a `---` fence. */
function opensWithFrontmatter(text: string): boolean {
	return /^---\r?\n/.test(text);
}

function isBlank(text: string): boolean {
	return text.trim() === "";
}

/**
 * Decide what to do with a write to a note's file.
 *
 * `refuse` comes before everything except the no-op, and it never falls back to
 * `reconcile`. Reconciling a refused write applies the same destruction and
 * leaves a file behind to tidy up, which is worse than declining twice.
 */
export function decideCarry(input: CarryInput): CarryDecision {
	const { crdtText, diskText, crdtHeldStill } = input;

	if (diskText === crdtText) {
		return { verdict: "noop", reason: "the file and the note already agree" };
	}

	// Carrying a write in makes it an ordinary CRDT operation on every device
	// that syncs this note. Two shapes of write are not worth that: a plugin
	// that serialises a note wrongly would otherwise delete somebody's
	// frontmatter everywhere at once, and there is no undo for it.
	if (!isBlank(crdtText) && isBlank(diskText)) {
		return {
			verdict: "refuse",
			reason: "the write empties a note that was not empty",
		};
	}
	if (opensWithFrontmatter(crdtText) && !opensWithFrontmatter(diskText)) {
		return {
			verdict: "refuse",
			reason: "the write removes the note's opening frontmatter fence",
		};
	}

	if (!crdtHeldStill) {
		return {
			verdict: "reconcile",
			reason: "the note moved since the file and the note last agreed",
		};
	}

	return {
		verdict: "carry",
		reason: "the note has not moved, so the file is what it says next",
	};
}

/**
 * Compare two Yjs state vectors. Two undefined vectors are not equal: an
 * absent vector means nothing has been agreed yet, and treating that as
 * agreement is exactly the mistake this whole module exists to avoid.
 */
export function stateVectorsEqual(
	a: Uint8Array | undefined,
	b: Uint8Array | undefined,
): boolean {
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
