/**
 * What linking a vault does, said out loud while it happens.
 *
 * Linking used to be one press and then nothing: the picker closed, a notice
 * said *Linked*, and the settings screen sat on *Syncing* over a vault whose
 * size nobody had been told. Everything that made the wait reasonable, how
 * much is already up there, how much is on this device, how much of it has to
 * move, was known inside the plugin at that moment and never said.
 *
 * So the link reports itself. Eight steps, in the order the facts become
 * true, and each one either a number or a phrase. Two of them are the ones
 * worth waiting for: what has to come down, and what has to go up.
 *
 * This file is pure. It holds the step list, the labels and the arithmetic,
 * and nothing in it knows about Obsidian, sockets or the modal that draws it.
 * The engine reports a step id and the facts so far; the modal turns that
 * into rows. That seam is why the interesting half is testable.
 */

/**
 * The eight, in order. The work does not happen in quite this order (the
 * local counts are taken before the socket opens, because they ride along on
 * it), but every number is true at the moment its step is reported, and this
 * is the order a person reads them in: the far side first, because that is
 * the side they cannot see.
 */
export const LINK_STEPS = [
	"connecting",
	"cloudNotes",
	"cloudAttachments",
	"localNotes",
	"localAttachments",
	"toDownload",
	"toUpload",
	"linked",
] as const;

export type LinkStep = (typeof LINK_STEPS)[number];

/** What the steps have found out so far. Filled in as they go. */
export interface LinkFacts {
	cloudNotes?: number;
	cloudAttachments?: number;
	localNotes?: number;
	localAttachments?: number;
	downloadNotes?: number;
	downloadAttachments?: number;
	uploadNotes?: number;
	uploadAttachments?: number;
}

/** Told each time a step is done, with everything known at that point. */
export type LinkReporter = (step: LinkStep, facts: LinkFacts) => void;

const LABELS: Record<LinkStep, string> = {
	connecting: "Connecting",
	cloudNotes: "Notes in the cloud vault",
	cloudAttachments: "Attachments in the cloud vault",
	localNotes: "Notes on this device",
	localAttachments: "Attachments on this device",
	toDownload: "To download",
	toUpload: "To upload",
	linked: "Linked",
};

export type StepState = "done" | "doing" | "waiting" | "failed";

export interface LinkRow {
	step: LinkStep;
	label: string;
	/** The number or phrase this step found, or "" while it has not. */
	value: string;
	state: StepState;
}

/**
 * The rows to draw, given the last step that finished.
 *
 * `done` is the step that just completed, or null before the first one.
 * Everything before it is done, the one after it is what is happening now,
 * and the rest are waiting. A failure stops the run where it stood: the step
 * that was in flight is the one that failed, and nothing after it happens.
 */
export function linkRows(done: LinkStep | null, facts: LinkFacts, failed = false): LinkRow[] {
	const at = done === null ? -1 : LINK_STEPS.indexOf(done);
	return LINK_STEPS.map((step, index) => ({
		step,
		label: LABELS[step],
		value: valueOf(step, facts),
		state: stateOf(index, at, failed),
	}));
}

function stateOf(index: number, at: number, failed: boolean): StepState {
	if (index <= at) return "done";
	if (index === at + 1) return failed ? "failed" : "doing";
	return "waiting";
}

function valueOf(step: LinkStep, facts: LinkFacts): string {
	switch (step) {
		case "cloudNotes":
			return number(facts.cloudNotes);
		case "cloudAttachments":
			return number(facts.cloudAttachments);
		case "localNotes":
			return number(facts.localNotes);
		case "localAttachments":
			return number(facts.localAttachments);
		case "toDownload":
			return movePhrase(facts.downloadNotes, facts.downloadAttachments);
		case "toUpload":
			return movePhrase(facts.uploadNotes, facts.uploadAttachments);
		default:
			// Connecting and the last line are acts rather than counts, and a
			// column of numbers with two blanks in it reads better than two
			// invented words.
			return "";
	}
}

function number(value?: number): string {
	return value === undefined ? "" : value.toLocaleString("en-US");
}

/**
 * "14 notes, 3 attachments", or "Nothing" when there is none of either.
 *
 * *Nothing* rather than *0*, because these two rows are the answer to how
 * long this is going to take, and a zero in a column of counts is read as a
 * number rather than as an answer.
 */
export function movePhrase(notes?: number, attachments?: number): string {
	if (notes === undefined || attachments === undefined) return "";
	const parts: string[] = [];
	if (notes > 0) parts.push(`${number(notes)} note${notes === 1 ? "" : "s"}`);
	if (attachments > 0) {
		parts.push(`${number(attachments)} attachment${attachments === 1 ? "" : "s"}`);
	}
	return parts.length > 0 ? parts.join(", ") : "Nothing";
}

/**
 * What has to move, counted as a plain difference between the two sides.
 *
 * Deliberately simpler than what the bindings then do. They have a record of
 * what this device last agreed with, so they can tell a note somebody deleted
 * here from one that has not arrived yet, and a fresh link has no such record
 * anyway. What a person wants before that starts is the size of the job: what
 * is on one side and not the other.
 */
export function linkCounts(
	cloud: { notes: Iterable<string>; attachments: Iterable<string> },
	local: { notes: Iterable<string>; attachments: Iterable<string> },
): Pick<
	LinkFacts,
	"downloadNotes" | "downloadAttachments" | "uploadNotes" | "uploadAttachments"
> {
	const cloudNotes = new Set(cloud.notes);
	const cloudFiles = new Set(cloud.attachments);
	const localNotes = new Set(local.notes);
	const localFiles = new Set(local.attachments);
	return {
		downloadNotes: missing(cloudNotes, localNotes),
		downloadAttachments: missing(cloudFiles, localFiles),
		uploadNotes: missing(localNotes, cloudNotes),
		uploadAttachments: missing(localFiles, cloudFiles),
	};
}

function missing(from: Set<string>, here: Set<string>): number {
	let count = 0;
	for (const path of from) if (!here.has(path)) count += 1;
	return count;
}
