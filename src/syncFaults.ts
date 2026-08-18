/**
 * An entry that fails every pass of the file tree says so (#89, ADR-0071).
 *
 * `syncFileTree` walks the share's file list and turns each entry into an
 * operation. One of those operations rejecting used to take the whole pass
 * down, and the rejection was voided into silence: a joined vault stayed
 * empty with every light green and the server heard nothing (#85). Since #88
 * the pass survives a bad entry and warns about it in the console, which is
 * the right behaviour for the pass and still tells nobody who could fix it.
 *
 * This is the other half. It keeps a streak per path: how many passes in a
 * row that entry has failed. A first failure is not worth anybody's time,
 * because a file being written while the pass reads it fails once and works
 * on the next one. An entry that fails on every pass is a bug, and it is the
 * failure mode that empties a vault, so from the second consecutive failure
 * it goes to the fault channel under `component=sync`.
 *
 * **The path is a key here and never leaves the device.** It is what tells
 * one failing entry from another between passes, and that is all it is used
 * for: what goes out is whatever `reportFault` sends, which is the error's
 * type, the component, the version and the platform (see `faults.ts`).
 */

import { reportFault } from "./faults";

/**
 * How many passes in a row an entry has to fail before it is reported.
 *
 * Two, which is the smallest number that means "again". One transient
 * failure, the file that moved under a pass or the folder that arrived a
 * moment later, never reaches the server.
 */
export const REPEATED_AFTER_PASSES = 2;

/** One entry that did not survive a pass. */
export interface EntryFailure {
	/** The entry's path, used to tell one entry from another. Never sent. */
	path: string;
	/** What it failed with. Scrubbed to its type before anything is sent. */
	error: unknown;
}

/**
 * The streaks, one share's worth.
 *
 * `pass` is handed everything that failed in one pass and works out which of
 * those are repeats. A path that is absent from a pass has stopped failing,
 * so its streak is forgotten rather than kept waiting: the map holds the
 * entries that are failing right now and nothing older.
 */
export class RepeatedEntryFailures {
	private streaks = new Map<string, number>();

	constructor(
		/** Injected so a test can drive this without a network at all. */
		private readonly report: (error: unknown) => void = (error) =>
			reportFault("sync", error),
		private readonly threshold: number = REPEATED_AFTER_PASSES,
	) {}

	/**
	 * Fold one pass's failures into the streaks and report the repeats.
	 *
	 * The same path can fail twice in one pass, because a folder create is
	 * awaited both on its own and again with the file creates. That is one
	 * entry failing once, not a streak of two, so a pass counts each path at
	 * most once and keeps the first error it saw for it.
	 *
	 * Returns how many faults were filed, which is what the tests assert on
	 * and what the caller logs.
	 */
	pass(failures: readonly EntryFailure[]): number {
		const thisPass = new Map<string, unknown>();
		for (const failure of failures) {
			if (!thisPass.has(failure.path)) {
				thisPass.set(failure.path, failure.error);
			}
		}

		const next = new Map<string, number>();
		let reported = 0;
		for (const [path, error] of thisPass) {
			const streak = (this.streaks.get(path) ?? 0) + 1;
			next.set(path, streak);
			if (streak >= this.threshold) {
				this.report(error);
				reported++;
			}
		}
		this.streaks = next;
		return reported;
	}

	/** How many entries are failing right now. For logging and for tests. */
	get failing(): number {
		return this.streaks.size;
	}
}
