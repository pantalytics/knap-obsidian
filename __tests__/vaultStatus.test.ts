/**
 * The word behind the mark in the status bar.
 *
 * The four words themselves are pinned in syncStatus.test.ts. What is tested
 * here is the step in front of them: which folders make a vault paused, which
 * make it syncing, and which leave it green. The icon in the corner is the
 * only place most people ever read this, so a folder that quietly reports the
 * wrong one is a vault somebody thinks is safe.
 *
 * The failure this file exists to keep out is #40. The status used to be one
 * boolean, `synced`, which is the folder's own metadata document having caught
 * up once. A vault of 2,567 notes satisfied it inside a minute with no note
 * bodies behind any of the paths, and the corner of the window said Up to
 * date. So the assertions below are mostly about what must NOT read green.
 */

import { PAUSED, SIGNED_OUT, SYNCING, UP_TO_DATE } from "../src/syncStatus";
import {
	SYNC_DOT_NAMES,
	folderCaughtUp,
	vaultCounts,
	vaultReading,
	vaultSyncWord,
	type FolderStatus,
} from "../src/vaultStatus";

/** A folder with nothing outstanding: the only shape that may read green. */
const synced: FolderStatus = {
	shouldConnect: true,
	synced: true,
	filling: false,
	total: 0,
	completed: 0,
	listed: 0,
	missing: 0,
};
/** Its own document has not caught up yet. */
const behind: FolderStatus = { ...synced, synced: false };
/** Switched off on this device. */
const off: FolderStatus = { ...synced, shouldConnect: false };
/** The vault from #40: every path registered, no body behind any of them. */
const registeredButEmpty: FolderStatus = {
	...synced,
	total: 2567,
	completed: 0,
};
/**
 * A phone that joined an existing cloud vault a moment ago.
 *
 * Nothing local to walk, so the fill was over before it started; the folder's
 * own document caught up in seconds; nothing is queued yet. Every count this
 * device keeps about its own work says done, and the vault is empty. The file
 * lists are the only thing that knows, which is what `missing` is.
 */
const justJoined: FolderStatus = {
	...synced,
	listed: 2567,
	missing: 2567,
};

describe("what the status bar says", () => {
	test("no account behind it is Signed out, whatever the folders say", () => {
		expect(vaultSyncWord(false, [synced])).toBe(SIGNED_OUT);
		expect(vaultSyncWord(false, [])).toBe(SIGNED_OUT);
	});

	test("everything caught up is Up to date, which is the green one", () => {
		expect(vaultSyncWord(true, [synced, synced])).toBe(UP_TO_DATE);
	});

	test("nothing shared yet reads as Up to date rather than inventing a state", () => {
		expect(vaultSyncWord(true, [])).toBe(UP_TO_DATE);
	});

	test("a folder that wants to be connected and is behind is Syncing", () => {
		expect(vaultSyncWord(true, [synced, behind])).toBe(SYNCING);
	});

	test("every folder off is Paused", () => {
		expect(vaultSyncWord(true, [off, off])).toBe(PAUSED);
	});

	test("one folder off is not a paused vault", () => {
		expect(vaultSyncWord(true, [off, synced])).toBe(UP_TO_DATE);
		expect(vaultSyncWord(true, [off, behind])).toBe(SYNCING);
	});

	test("the dot names cover the four words, so the last dot always comes off", () => {
		expect([...SYNC_DOT_NAMES].sort()).toEqual(["error", "ok", "wait", "working"]);
	});
});

/**
 * #40 in one describe. Each of these is a state the old status read as green.
 */
describe("what must never read Up to date", () => {
	test("paths registered and no bodies behind them", () => {
		expect(vaultSyncWord(true, [registeredButEmpty])).toBe(SYNCING);
		expect(folderCaughtUp(registeredButEmpty)).toBe(false);
	});

	test("one note of 2,567 short", () => {
		// The count that rounds to 100% and is still a note somebody wrote
		// sitting on this laptop and nowhere else.
		const nearly = { ...synced, total: 2567, completed: 2566 };

		expect(vaultSyncWord(true, [nearly])).toBe(SYNCING);
	});

	test("a note that came back without its body", () => {
		// Since #38 a sync that wrote nothing is marked failed, so it never
		// reaches completed. The folder is not busy and never will be again
		// on its own, and it is still not up to date.
		const failed = { ...synced, total: 10, completed: 9 };

		expect(vaultSyncWord(true, [failed])).toBe(SYNCING);
	});

	test("the walk that registers the local files is still running", () => {
		// Nothing is queued yet, so the counts agree with each other and say
		// nothing. On a large vault this state lasts minutes.
		const walking = { ...synced, filling: true };

		expect(vaultSyncWord(true, [walking])).toBe(SYNCING);
		expect(folderCaughtUp(walking)).toBe(false);
	});

	test("the folder's own document has caught up and the notes have not", () => {
		// The whole of the bug: `synced` is one document, one time, and it is
		// the only thing the old status looked at.
		expect(registeredButEmpty.synced).toBe(true);
		expect(vaultSyncWord(true, [registeredButEmpty])).toBe(SYNCING);
	});

	test("one folder of two is still filling", () => {
		expect(vaultSyncWord(true, [synced, { ...synced, filling: true }])).toBe(
			SYNCING,
		);
	});

	test("a device that has just joined and holds none of the notes yet", () => {
		// The phone half of #40. Every count this device keeps about its own
		// work says done, because it has not been given any work yet, and the
		// vault is empty. Reading green here is the same lie from the other
		// direction.
		expect(justJoined.synced).toBe(true);
		expect(justJoined.filling).toBe(false);
		expect(justJoined.total).toBe(0);

		expect(folderCaughtUp(justJoined)).toBe(false);
		expect(vaultSyncWord(true, [justJoined])).toBe(SYNCING);
	});

	test("a download most of the way through is still not up to date", () => {
		const nearly = { ...justJoined, missing: 1 };

		expect(vaultSyncWord(true, [nearly])).toBe(SYNCING);
	});

	test("the last note arriving is what turns it green", () => {
		const arrived = { ...justJoined, missing: 0 };

		expect(folderCaughtUp(arrived)).toBe(true);
		expect(vaultSyncWord(true, [arrived])).toBe(UP_TO_DATE);
	});

	test("every note is up and the folder document is not", () => {
		expect(
			vaultSyncWord(true, [{ ...synced, synced: false, total: 5, completed: 5 }]),
		).toBe(SYNCING);
	});
});

describe("a folder that is caught up", () => {
	test("needs all three, and gets there when the last note lands", () => {
		expect(folderCaughtUp({ ...synced, total: 2567, completed: 2567 })).toBe(true);
	});

	test("a folder with no notes at all is caught up", () => {
		expect(folderCaughtUp(synced)).toBe(true);
	});
});

describe("the count, which is the plugin's own and not the server's", () => {
	test("adds up the folders this device is carrying", () => {
		expect(
			vaultCounts([
				{ ...synced, total: 2000, completed: 290 },
				{ ...synced, total: 567, completed: 0 },
			]),
		).toEqual({ done: 290, total: 2567 });
	});

	test("leaves out a folder that is switched off, which is not moving", () => {
		expect(
			vaultCounts([
				{ ...synced, total: 100, completed: 40 },
				{ ...off, total: 900, completed: 0 },
			]),
		).toEqual({ done: 40, total: 100 });
	});

	test("with an empty queue, the file lists are what there is to count", () => {
		expect(vaultCounts([{ ...justJoined, missing: 2300 }])).toEqual({
			done: 267,
			total: 2567,
		});
	});

	test("the queue wins while there is one, so nothing is counted twice", () => {
		// A note being fetched is queued and absent at the same moment. Adding
		// the two counts it twice, and on the device that uploaded the vault
		// every note is listed and present, which would read as nearly done
		// during a first upload that had barely started.
		expect(
			vaultCounts([
				{ ...synced, total: 2567, completed: 290, listed: 2567, missing: 0 },
			]),
		).toEqual({ done: 290, total: 2567 });
	});

	test("a vault whose notes are all here counts nothing", () => {
		expect(vaultCounts([{ ...synced, listed: 2567, missing: 0 }])).toEqual({
			done: 0,
			total: 0,
		});
	});
});

describe("the reading both screens draw from", () => {
	test("says how far a first sync has got, in notes", () => {
		const reading = vaultReading(true, [
			{ ...synced, total: 2567, completed: 290 },
		]);

		expect(reading.word).toBe(SYNCING);
		expect(reading.dot).toBe("working");
		expect(reading.counts).toBe("290 of 2,567");
		expect(reading.progress).toBeCloseTo(290 / 2567);
	});

	test("counts nothing once there is nothing left to carry", () => {
		const reading = vaultReading(true, [
			{ ...synced, total: 2567, completed: 2567 },
		]);

		expect(reading.word).toBe(UP_TO_DATE);
		expect(reading.counts).toBe("");
		expect(reading.progress).toBeUndefined();
	});

	test("no bar while the walk is still finding out how much there is", () => {
		const reading = vaultReading(true, [{ ...synced, filling: true }]);

		expect(reading.word).toBe(SYNCING);
		expect(reading.counts).toBe("");
		expect(reading.progress).toBeUndefined();
	});

	test("a device downloading a vault it just joined says how far in it is", () => {
		const reading = vaultReading(true, [{ ...justJoined, missing: 2300 }]);

		expect(reading.word).toBe(SYNCING);
		expect(reading.counts).toBe("267 of 2,567");
		expect(reading.progress).toBeCloseTo(267 / 2567);
	});

	test("a signed-out vault gets no count either", () => {
		const reading = vaultReading(false, [
			{ ...synced, total: 2567, completed: 290 },
		]);

		expect(reading.word).toBe(SIGNED_OUT);
		expect(reading.counts).toBe("");
		expect(reading.progress).toBeUndefined();
	});
});

describe("a vault that is not syncing and is not about to be", () => {
	// A vault with nothing shared normally reads Up to date, because signing in
	// shares the whole vault and the gap is a moment long. Two things make that
	// gap permanent: something else syncing the same folder, which holds the
	// vault back (#41), and a vault waiting to be told which one on Knap it
	// belongs to (#42). Saying Up to date over either is the same lie as #40.

	test("held with nothing shared reads Paused, not Up to date", () => {
		expect(vaultSyncWord(true, [], true)).toBe(PAUSED);
		expect(vaultReading(true, [], true).word).toBe(PAUSED);
		expect(vaultReading(true, [], true).dot).toBe("wait");
	});

	test("the same vault unheld is the old answer, untouched", () => {
		expect(vaultSyncWord(true, [])).toBe(UP_TO_DATE);
		expect(vaultSyncWord(true, [], false)).toBe(UP_TO_DATE);
	});

	test("held never outranks being signed out", () => {
		expect(vaultSyncWord(false, [], true)).toBe(SIGNED_OUT);
	});

	test("held is ignored once the vault has a folder to report on", () => {
		// The flag is about a vault with nothing shared. A folder that is
		// actually carrying notes says so itself, and a stale flag must not
		// paint Paused over a vault that is working.
		expect(vaultSyncWord(true, [{ ...synced, total: 10, completed: 3 }], true)).toBe(
			SYNCING,
		);
		expect(vaultSyncWord(true, [synced], true)).toBe(UP_TO_DATE);
	});

	test("a held vault has nothing to count and no bar to draw", () => {
		const reading = vaultReading(true, [], true);
		expect(reading.counts).toBe("");
		expect(reading.progress).toBeUndefined();
	});
});
