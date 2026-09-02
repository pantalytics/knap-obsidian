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
 * refused upload had to present itself as a missing account. The test for
 * adding one was that a word earns its place when the reader's next move is
 * different: Offline is wait, Problem is act.
 *
 * **Uploading and Downloading came the same day, and they fail that test**
 * (ADR-0089, which supersedes ADR-0088 on this one point). Both mean wait,
 * exactly as Syncing does. They are here because the reader's next move is not
 * the only thing a word is for: *Uploading* over the notes somebody wrote this
 * morning tells them their own work is the thing in flight, and *Downloading*
 * over a vault they have just joined tells them the wait is somebody else's
 * notes arriving. Syncing said neither, and a person watching a first sync for
 * an hour wants to know which of the two it is.
 *
 * **Initializing came on 2026-09-02** (ADR-0090), and it passes the older,
 * stricter test rather than the one ADR-0089 loosened: the reader's next move
 * really is different. Under Syncing a person may close the laptop, and the
 * sentence under it says so. Under Initializing they may not yet, because this
 * is the first pass over a vault that has just been linked and the whole of it
 * is still on its way. One word covers both directions here on purpose: a
 * first sync is usually both at once, and which way it is going is the least
 * interesting thing about it.
 *
 * The header used to say this list mirrored `status.py` in the admin
 * repository. That file went with the 2026-08-18 rebuild and the panel now
 * words a vault's standing for itself in `panel.py`. There is nothing on the
 * other side to keep in step with today, so this file is the list.
 */

export const INITIALIZING = "Initializing";
export const SYNCING = "Syncing";
export const UPLOADING = "Uploading";
export const DOWNLOADING = "Downloading";
export const UP_TO_DATE = "Up to date";
export const PAUSED = "Paused";
export const OFFLINE = "Offline";
export const SIGNED_OUT = "Signed out";
export const PROBLEM = "Problem";

/** In the order a vault moves through them, trouble last. */
export const SYNC_WORDS = [
	INITIALIZING,
	SYNCING,
	UPLOADING,
	DOWNLOADING,
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
	[INITIALIZING]: "working",
	[SYNCING]: "working",
	[UPLOADING]: "working",
	[DOWNLOADING]: "working",
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
	 * Notes and attachments still to reach the cloud vault, and still to
	 * reach this device. They pick which of the three moving words is said
	 * (ADR-0089). Left out by callers that cannot split their queue, which
	 * read as both and get Syncing.
	 */
	up?: number;
	down?: number;
	/**
	 * A socket is up. Left out by callers that cannot tell, which read as
	 * connected: a status that cries Offline because nobody asked is worse
	 * than one that says nothing.
	 */
	connected?: boolean;
	/** Pieces of work that failed and stayed failed. */
	stuck?: number;
	/**
	 * This vault has been linked and has not finished its first pass yet.
	 *
	 * It picks Initializing over the three ordinary moving words. Not a
	 * separate branch in the order below, because it is the same fact as
	 * `syncing` with one thing added: which sync this is.
	 */
	initial?: boolean;
	/**
	 * The server refused this device the vault: taken out of it, or the
	 * vault is gone.
	 *
	 * Not a sixth word. The rule for adding one is that the reader's next
	 * move has to be different, and this reader's move is the one Problem
	 * already covers: go and do something, because waiting will not fix it.
	 * What differs is the sentence beside the word, which the host says.
	 */
	lost?: boolean;
}

/**
 * One word for a vault, and the order is the argument.
 *
 * No account beats everything, because nothing else is even attempted
 * without one. Paused beats the rest because the person did it on purpose.
 * **Offline beats Problem**: a device with no connection has everything
 * stuck, and blaming the notes for what the tunnel did sends somebody
 * looking in the wrong place.
 *
 * **Lost beats Offline**, for the same reason inverted. A device that was
 * taken out of a vault has no socket either, and it never will have one
 * again: saying Offline would send somebody to check their wifi over a
 * membership somebody else ended.
 */
export function syncWord(state: VaultState): SyncWord {
	if (!state.signedIn) return SIGNED_OUT;
	if (state.paused) return PAUSED;
	if (state.lost) return PROBLEM;
	if (state.connected === false) return OFFLINE;
	if ((state.stuck ?? 0) > 0) return PROBLEM;
	if (state.syncing) {
		// The first pass beats the direction, because what somebody has to do
		// about it is different: leave this one running.
		return state.initial ? INITIALIZING : movingWord(state.up, state.down);
	}
	return UP_TO_DATE;
}

/**
 * Which of the three moving words this vault is doing.
 *
 * One direction gets its own word, because that is the one a person can
 * check against what they just did: *Uploading* over the notes they wrote
 * this morning, *Downloading* over a vault they have just joined. Both at
 * once is Syncing, and so is a vault whose queue cannot say which way it is
 * going, because a word that guesses is worse than the general one.
 */
export function movingWord(up = 0, down = 0): SyncWord {
	if (up > 0 && down <= 0) return UPLOADING;
	if (down > 0 && up <= 0) return DOWNLOADING;
	return SYNCING;
}

/** Whether this word is one of the three that mean notes are on the move. */
export function isMoving(word: SyncWord): boolean {
	return (
		word === INITIALIZING || word === SYNCING || word === UPLOADING || word === DOWNLOADING
	);
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
		case INITIALIZING:
			return (
				"The first sync brings the whole vault over, and it takes a while. " +
				"Leave Obsidian open until it finishes."
			);
		case SIGNED_OUT:
			return "Your notes are all still on this device. Sign in again to carry on.";
		case PAUSED:
			return "Nothing is moving while this device is paused.";
		case OFFLINE:
			return "Your changes are saved here and go up when the connection is back.";
		case PROBLEM:
			return "Everything else is up to date, and nothing was lost.";
		case SYNCING:
		case UPLOADING:
		case DOWNLOADING:
			return "Leave Obsidian open until it finishes. It picks up where it left off if you close it.";
		default:
			return "";
	}
}

/** Only Signed out gets a button, and only on this side. */
export function hasSignInButton(word: SyncWord): boolean {
	return word === SIGNED_OUT;
}
