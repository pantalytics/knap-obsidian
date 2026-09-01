"use strict";

/**
 * How long the corner of the window waits before it says anything.
 *
 * Three things move notes and only one of them is worth a mark on screen for
 * as long as it lasts (ADR-0088). A first sync runs for minutes and somebody
 * is watching it. An edit to a note both sides already have is over in under a
 * second, and it used to flip the icon, grow a count and draw a bar every time
 * a note was saved. A mark that moves all day is a mark the eye stops reading,
 * which costs the two moments it is there for.
 *
 * So the corner lags the vault, deliberately, at both ends: two seconds before
 * it admits that notes are moving, two seconds of Up to date after they stop.
 * Everyday typing never gets past the first of those. A real sync loses two
 * seconds off the front of something that takes minutes.
 *
 * **Only the moving state is held back.** Problem, Offline and Signed out go up
 * the instant they are true, because those are the ones somebody has to do
 * something about.
 */

/** Two seconds at each end. Long enough for a save, short enough to trust. */
export const QUIET_MS = 2000;

/** What the corner is saying, and what it needs to keep saying it. */
export interface Burst {
	/** What is on screen, which is not always what the vault is doing. */
	moving: boolean;
	/** When the vault started disagreeing with the screen, or null. */
	since: number | null;
	/**
	 * The largest backlog seen since this burst began, which is what the bar
	 * is drawn against. It cannot come from the vault, because the vault only
	 * knows what is left: a bar against a shrinking denominator never moves.
	 */
	peak: number;
}

/** Nothing on screen, nothing pending. Where every corner starts. */
export const STILL: Burst = { moving: false, since: null, peak: 0 };

/**
 * The corner already saying it is moving. Nothing produces this state on its
 * own; it is what a caller passes when the delay is not what is under test.
 */
export const RUNNING: Burst = { moving: true, since: null, peak: 0 };

/**
 * Fold one reading into the burst.
 *
 * `moving` is the vault's own answer, `backlog` is how many notes are behind
 * it, and `now` is a clock the caller owns so a test does not have to wait two
 * seconds to find out what happens after two seconds.
 */
export function settle(
	prev: Burst,
	moving: boolean,
	backlog: number,
	now: number,
): Burst {
	if (moving === prev.moving) {
		// Screen and vault agree. Nothing is pending, and a burst that is
		// running keeps its high-water mark.
		return {
			moving,
			since: null,
			peak: moving ? Math.max(prev.peak, backlog) : 0,
		};
	}
	// Null rather than zero, because a clock that reads zero is a clock a
	// test set, and a sentinel that a legitimate reading can equal is a
	// sentinel that stops working exactly where it is being checked.
	const since = prev.since ?? now;
	if (now - since < QUIET_MS) {
		return { moving: prev.moving, since, peak: prev.peak };
	}
	// Held long enough to be worth saying.
	return { moving, since: null, peak: moving ? backlog : 0 };
}

/**
 * The count beside the icon: two directions, or one, or nothing.
 *
 * The arrows do the labelling because the corner has room for a number and
 * not for a sentence. The tooltip says it in words, and the words are the ones
 * that already exist (ADR-0038): cloud vault, and device.
 */
export function backlogText(up: number, down: number): string {
	const parts: string[] = [];
	if (up > 0) parts.push(`↑ ${group(up)}`);
	if (down > 0) parts.push(`↓ ${group(down)}`);
	return parts.join(" ");
}

/** The same two numbers, said out loud. */
export function backlogLabel(up: number, down: number): string {
	const parts: string[] = [];
	if (up > 0) parts.push(`${group(up)} to the cloud vault`);
	if (down > 0) parts.push(`${group(down)} to this device`);
	return parts.join(", ");
}

/**
 * How full the bar is, 0 to 1, or undefined when there is nothing to draw it
 * against. What has landed over what this burst started with, which is the
 * only pair of numbers here that both exist.
 */
export function burstProgress(
	burst: Burst,
	backlog: number,
): number | undefined {
	if (!burst.moving || burst.peak <= 0) return undefined;
	const done = burst.peak - Math.min(backlog, burst.peak);
	return Math.min(1, done / burst.peak);
}

/** Thousands separators, the way the rest of the status says them. */
function group(n: number): string {
	return n.toLocaleString("en-US");
}
