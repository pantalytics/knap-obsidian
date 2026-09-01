"use strict";

/**
 * What a vault is doing, in the only words a screen may use for it.
 *
 * The screens once showed *Uploading, 412 of 1,202* on one side and *Syncing,
 * 412 notes so far* on the other for one fact, which teaches a person they are
 * watching two things fail in two ways. One list, and both screens read it.
 *
 * The word, the dot, the counts and the bar are the same wherever the state is
 * shown. Only the instruction under them differs, and only Signed out carries a
 * button, here, because this is where the fix lives.
 *
 * **Offline and Problem were added on 2026-09-01**, because four words could
 * not say that something is wrong. Signed out held the only error dot, so a
 * refused upload had to present itself as a missing account. The rule for
 * adding one is that a word earns its place when the reader's next move is
 * different: Offline is wait, Problem is act.
 *
 * The header used to say this list mirrored `status.py` in the admin
 * repository. That file went with the 2026-08-18 rebuild and the panel now
 * words a vault's standing for itself in `panel.py`. There is nothing on the
 * other side to keep in step with today, so this file is the list.
 */

export const SYNCING = "Syncing";
export const UP_TO_DATE = "Up to date";
export const PAUSED = "Paused";
export const OFFLINE = "Offline";
export const SIGNED_OUT = "Signed out";
export const PROBLEM = "Problem";

/** In the order a vault moves through them, trouble last. */
export const SYNC_WORDS = [
	SYNCING,
	UP_TO_DATE,
	PAUSED,
	OFFLINE,
	SIGNED_OUT,
	PROBLEM,
] as const;

export type SyncWord = (typeof SYNC_WORDS)[number];

/**
 * The dot beside the word: how bad it is, while the word says what it is.
 *
 * Two words share each of the two unhappy dots on purpose. Yellow is wait,
 * and both Paused and Offline resolve without anybody doing anything. Red is
 * act, and both Signed out and Problem need a person.
 */
export type SyncDot = "ok" | "working" | "wait" | "error";

const DOTS: Record<SyncWord, SyncDot> = {
	[SYNCING]: "working",
	[UP_TO_DATE]: "ok",
	[PAUSED]: "wait",
	[OFFLINE]: "wait",
	[SIGNED_OUT]: "error",
	[PROBLEM]: "error",
};

export function syncDot(word: SyncWord): SyncDot {
	return DOTS[word] ?? "wait";
}

/**
 * What this side knows about a vault, which is not what the other side knows.
 *
 * Knap counts the search copy it holds; the plugin knows whether there is an
 * account, whether the share is connected, and how much of the first pass has
 * gone up. Different facts, same four words out.
 */
export interface VaultState {
	signedIn: boolean;
	/** The person, or the plugin, has stopped this device syncing. */
	paused: boolean;
	/** A share exists and its documents are still going up or coming down. */
	syncing: boolean;
	/**
	 * A socket is up. Left out by callers that cannot tell, which read as
	 * connected: a status that cries Offline because nobody asked is worse
	 * than one that says nothing.
	 */
	connected?: boolean;
	/** Pieces of work that failed and stayed failed. */
	stuck?: number;
}

/**
 * One word for a vault, and the order is the argument.
 *
 * No account beats everything, because nothing else is even attempted
 * without one. Paused beats the rest because the person did it on purpose.
 * **Offline beats Problem**: a device with no connection has everything
 * stuck, and blaming the notes for what the tunnel did sends somebody
 * looking in the wrong place.
 */
export function syncWord(state: VaultState): SyncWord {
	if (!state.signedIn) return SIGNED_OUT;
	if (state.paused) return PAUSED;
	if (state.connected === false) return OFFLINE;
	if ((state.stuck ?? 0) > 0) return PROBLEM;
	if (state.syncing) return SYNCING;
	return UP_TO_DATE;
}

/**
 * The count, in the one phrasing both screens use. Mirrors
 * status.sync_counts.
 *
 * A total is known once something has counted the far side, and unknown while
 * the first pass is still discovering how much there is. Saying "412 of 1,202"
 * when the second number is a guess is worse than not saying it, so the
 * phrasing changes rather than the number being invented.
 */
export function syncCounts(done: number, total?: number): string {
	if (total && total > 0) {
		return `${group(done)} of ${group(total)}`;
	}
	if (done === 1) return "1 note so far";
	return `${group(done)} notes so far`;
}

/**
 * How full the bar is, 0 to 1, or undefined when there is no bar to draw.
 * Mirrors status.sync_progress. No total, no bar: a bar filling against an
 * unknown denominator is a spinner wearing a percentage.
 */
export function syncProgress(done: number, total?: number): number | undefined {
	if (!total || total <= 0) return undefined;
	if (done <= 0) return 0;
	return Math.min(1, done / total);
}

/** Thousands separators, the way Python's format spec writes them. */
function group(n: number): string {
	return n.toLocaleString("en-US");
}

/**
 * The instruction under the word. This half is allowed to differ from Knap's
 * page, and does: the fix for being signed out lives here.
 */
export function syncInstruction(word: SyncWord): string {
	switch (word) {
		case SIGNED_OUT:
			return "Your notes are all still on this device. Sign in again to carry on.";
		case PAUSED:
			return "Nothing is moving while this device is paused.";
		case OFFLINE:
			return "Your changes are saved here and go up when the connection is back.";
		case PROBLEM:
			return "Everything else is up to date, and nothing was lost.";
		case SYNCING:
			return "Leave Obsidian open until it finishes. It picks up where it left off if you close it.";
		default:
			return "";
	}
}

/** Only Signed out gets a button, and only on this side. */
export function hasSignInButton(word: SyncWord): boolean {
	return word === SIGNED_OUT;
}
