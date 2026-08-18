/**
 * The notes the first fill leaves empty, offered again (#56).
 *
 * Measured on a vault of 2582 notes: the fill ran to 2576 and stopped. Four
 * of the six that were left had content on disk and nothing on the relay,
 * and sixteen minutes and a full scrub later they were still empty. Opening
 * any one of them by hand fixed it inside a minute. Nothing on the screen
 * said anything was missing, because the plugin had finished everything it
 * knew about: the walk had been over every file, so it reported itself done.
 *
 * Four in 2582 is 99.84%, which is close enough to right to go unnoticed,
 * and that is what makes it worth a module. An empty note and a note nobody
 * ever wrote are the same two bytes on the relay, so a reader of the vault
 * has no way to tell one from the other. Nobody finds out.
 *
 * So the fill ends with a sweep rather than an announcement: which paths the
 * file list holds a document for, which of those documents are empty, and
 * which of those have bytes on this disk. Anything in all three is offered
 * to the sync queue again, which is what opening the note by hand does.
 *
 * Two rules keep this from becoming a machine that never stops:
 *
 * - **A note that is empty on disk is left alone, every time.** One of the
 *   six in the measurement was `Anaïs' dagboek.md`, 0 bytes on disk and
 *   correctly 0 bytes on the relay. There is nothing to offer and no round
 *   at which offering it starts working.
 * - **The sweep runs a fixed number of rounds and then gives up.** A note
 *   that is still empty after the last round stays empty, and the count is
 *   logged. A repair loop with no end is a worse bug than the one it fixes.
 */

/** What the sweep needs from the share it is sweeping. */
export interface SweepDeps {
	/**
	 * The paths whose document is loaded here and currently holds nothing.
	 *
	 * Loaded documents only. Asking every path in the file list about itself
	 * would open every note in the vault, which is the fan-out lazy documents
	 * exist to avoid, and a note nobody has opened was never part of this
	 * fill anyway.
	 *
	 * Returning nothing ends the sweep, which is also how a share that is
	 * being torn down gets out of it.
	 */
	empty(): string[];
	/**
	 * How many bytes that note has on this disk. Zero for a file that is not
	 * there, and zero for a file that is genuinely empty: neither is a note
	 * with content waiting to be uploaded, and the two do not have to be told
	 * apart because the answer for both is to do nothing.
	 */
	localBytes(vpath: string): number;
	/** Offer the note to the sync queue again. */
	offer(vpath: string): void;
	wait(ms: number): Promise<void>;
	log(message: string): void;
}

/**
 * How long the sweep waits before each round.
 *
 * The first fill of a few thousand notes is still uploading long after the
 * walk over the files has finished, so most of what is empty a minute in is
 * empty because its turn has not come. Offering those again costs nothing:
 * the sync queue skips anything it is already holding. The later rounds are
 * for what is left once the queue has drained, which is where the four notes
 * in the measurement were.
 *
 * The length of this array is the number of rounds, and it is the whole of
 * what bounds the sweep.
 */
export const SWEEP_WAITS_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** What the sweep did. Counts and never paths, so it is safe to log. */
export interface SweepReport {
	/** Rounds that ran, of SWEEP_WAITS_MS.length. */
	rounds: number;
	/** Notes offered again, added up over the rounds. */
	offered: number;
	/**
	 * Notes that had content on disk and nothing on the relay at the last
	 * check. The last round's offers had not landed yet when this was
	 * counted, so it is the size of the problem going into that round rather
	 * than what was left after it.
	 */
	stillEmpty: number;
}

/**
 * Run the sweep. Resolves when it has nothing left to offer or has run out
 * of rounds, whichever comes first.
 */
export async function sweepEmptyDocs(
	deps: SweepDeps,
	waits: readonly number[] = SWEEP_WAITS_MS,
): Promise<SweepReport> {
	let offered = 0;
	let rounds = 0;
	let stillEmpty = 0;

	for (const wait of waits) {
		await deps.wait(wait);
		rounds++;

		const candidates = deps
			.empty()
			.filter((vpath) => deps.localBytes(vpath) > 0);
		stillEmpty = candidates.length;
		if (stillEmpty === 0) {
			return { rounds, offered, stillEmpty: 0 };
		}

		deps.log(
			`[sweep] round ${rounds}: ${stillEmpty} notes have content here and nothing on the relay, offering them again`,
		);
		for (const vpath of candidates) {
			deps.offer(vpath);
			offered++;
		}
	}

	if (stillEmpty > 0) {
		deps.log(
			`[sweep] out of rounds after ${rounds}, with ${stillEmpty} notes still empty at the last check`,
		);
	}
	return { rounds, offered, stillEmpty };
}
