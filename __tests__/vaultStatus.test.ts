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

import {
	DOWNLOADING,
	OFFLINE,
	PAUSED,
	PROBLEM,
	SIGNED_OUT,
	SYNCING,
	UPLOADING,
	UP_TO_DATE,
	syncDot,
} from "../src/syncStatus";
import {
	SYNC_DOT_NAMES,
	folderCaughtUp,
	statusBarPaint,
	vaultCounts,
	vaultReading,
	vaultSyncWord,
	type FolderStatus,
} from "../src/vaultStatus";
import { RUNNING, STILL } from "../src/quiet";

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

describe("the corner of the window", () => {
	// The bar is the half of the status somebody reads without looking at it,
	// so what is pinned here is when it is drawn at all. A bar filling against
	// an unknown total is a spinner wearing a percentage (syncStatus.ts), and
	// an empty track beside a finished vault reads as work that never started.

	test("a first sync draws the bar, the count and the word", () => {
		const paint = statusBarPaint(
			vaultReading(true, [{ ...synced, total: 1202, completed: 412 }]),
			RUNNING,
		);
		expect(paint.dot).toBe("working");
		expect(paint.count).toBe("412 of 1,202");
		expect(paint.label).toBe("Knap: syncing, 412 of 1,202");
		expect(paint.percent).toBe(34);
	});

	test("a device downloading a vault it just joined draws one too", () => {
		const paint = statusBarPaint(vaultReading(true, [justJoined]), RUNNING);
		expect(paint.percent).toBe(0);
		expect(paint.count).toBe("0 of 2,567");
	});

	test("a caught up vault has no bar and nothing to count", () => {
		const paint = statusBarPaint(vaultReading(true, [synced]), RUNNING);
		expect(paint.percent).toBeUndefined();
		expect(paint.count).toBe("");
		expect(paint.label).toBe("Knap: up to date");
	});

	test("signed out has no bar, whatever the folders were carrying", () => {
		const paint = statusBarPaint(
			vaultReading(false, [{ ...synced, total: 1202, completed: 412 }]),
			RUNNING,
		);
		expect(paint.percent).toBeUndefined();
		expect(paint.label).toBe("Knap: signed out");
	});

	test("the percent never runs past the end of the track", () => {
		// More done than there is to do is a queue that counted a note twice,
		// and a fill wider than its track is what it would draw.
		const paint = statusBarPaint(
			vaultReading(true, [{ ...synced, total: 10, completed: 40, missing: 1 }]),
			RUNNING,
		);
		expect(paint.percent).toBe(100);
	});
});

describe("the corner, split by direction", () => {
	const syncing = {
		word: SYNCING,
		dot: "working" as const,
		done: 0,
		total: 0,
		counts: "",
		progress: undefined,
		up: 412,
		down: 2567,
	};

	test("both numbers, and the tooltip says which is which", () => {
		const paint = statusBarPaint(syncing, { moving: true, since: null, peak: 3000 });
		expect(paint.count).toBe("\u2191 412 \u2193 2,567");
		expect(paint.label).toBe("Knap: syncing, 412 to the cloud vault, 2,567 to this device");
		// 3,000 to start with, 2,979 still to go.
		expect(paint.percent).toBe(1);
	});

	test("a vault that is only sending says only that", () => {
		const paint = statusBarPaint(
			{ ...syncing, down: 0 },
			{ moving: true, since: null, peak: 412 },
		);
		expect(paint.count).toBe("\u2191 412");
	});

	test("the corner says nothing until the delay is up", () => {
		const paint = statusBarPaint(syncing, STILL);
		expect(paint.dot).toBe("ok");
		expect(paint.count).toBe("");
		expect(paint.label).toBe("Knap: up to date");
		expect(paint.percent).toBeUndefined();
	});

	test("the delay never holds back a word somebody has to act on", () => {
		for (const word of [PROBLEM, OFFLINE, SIGNED_OUT] as const) {
			const paint = statusBarPaint({ ...syncing, word, dot: syncDot(word) }, STILL);
			expect(paint.dot).not.toBe("ok");
			expect(paint.count).toBe("\u2191 412 \u2193 2,567");
		}
	});
});

describe("the word the corner says out loud", () => {
	// ADR-0089: the direction is in the word now, not only in the arrows.
	const moving = {
		dot: "working" as const,
		done: 0,
		total: 0,
		counts: "",
		progress: undefined,
	};
	const running = { moving: true, since: null, peak: 3000 };

	test("one direction names itself in the tooltip", () => {
		expect(
			statusBarPaint({ ...moving, word: UPLOADING, up: 412, down: 0 }, running).label,
		).toBe("Knap: uploading, 412 to the cloud vault");
		expect(
			statusBarPaint({ ...moving, word: DOWNLOADING, up: 0, down: 2567 }, running).label,
		).toBe("Knap: downloading, 2,567 to this device");
	});

	test("both directions keep the word they had", () => {
		expect(
			statusBarPaint({ ...moving, word: SYNCING, up: 412, down: 2567 }, running).label,
		).toBe("Knap: syncing, 412 to the cloud vault, 2,567 to this device");
	});

	test("the delay holds all three back, not only the one it was written for", () => {
		for (const word of [SYNCING, UPLOADING, DOWNLOADING] as const) {
			const paint = statusBarPaint({ ...moving, word, up: 412, down: 0 }, STILL);
			expect(paint.dot).toBe("ok");
			expect(paint.label).toBe("Knap: up to date");
		}
	});
});
