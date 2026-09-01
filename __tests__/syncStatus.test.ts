/**
 * The words, pinned.
 *
 * Pinned rather than merely used, because every screen reads this list and a
 * word that quietly changes shape is a vault described two ways. Offline and
 * Problem joined on 2026-09-01; the order they win in is the part worth
 * testing, not the strings on their own.
 */

import {
	SYNC_WORDS,
	OFFLINE,
	PROBLEM,
	SIGNED_OUT,
	PAUSED,
	SYNCING,
	UP_TO_DATE,
	hasSignInButton,
	syncCounts,
	syncDot,
	syncInstruction,
	syncProgress,
	syncWord,
} from "../src/syncStatus";

describe("the words", () => {
	test("these are they, in this order", () => {
		expect(SYNC_WORDS).toEqual([
			"Syncing",
			"Up to date",
			"Paused",
			"Offline",
			"Signed out",
			"Problem",
		]);
	});

	test("no account behind it is Signed out, whatever else is true", () => {
		expect(syncWord({ signedIn: false, paused: true, syncing: true })).toBe(SIGNED_OUT);
	});

	test("paused beats syncing, because nothing is actually moving", () => {
		expect(syncWord({ signedIn: true, paused: true, syncing: true })).toBe(PAUSED);
	});

	test("notes on the move are Syncing", () => {
		expect(syncWord({ signedIn: true, paused: false, syncing: true })).toBe(SYNCING);
	});

	test("nothing left to carry is Up to date", () => {
		expect(syncWord({ signedIn: true, paused: false, syncing: false })).toBe(UP_TO_DATE);
	});

	test("no socket is Offline, and it beats the work that is stuck behind it", () => {
		// A device in a tunnel has everything stuck. Calling that Problem
		// sends somebody looking at their notes for what the tunnel did.
		expect(
			syncWord({
				signedIn: true,
				paused: false,
				syncing: true,
				connected: false,
				stuck: 3,
			}),
		).toBe(OFFLINE);
	});

	test("connected and stuck is Problem, even while other notes move", () => {
		expect(
			syncWord({
				signedIn: true,
				paused: false,
				syncing: true,
				connected: true,
				stuck: 1,
			}),
		).toBe(PROBLEM);
	});

	test("a caller that cannot tell about the socket is not treated as offline", () => {
		// Left out, not false: a status that cries Offline because nobody
		// asked is worse than one that says nothing.
		expect(syncWord({ signedIn: true, paused: false, syncing: false })).toBe(UP_TO_DATE);
	});

	test("paused beats offline, because the person did it on purpose", () => {
		expect(
			syncWord({ signedIn: true, paused: true, syncing: false, connected: false }),
		).toBe(PAUSED);
	});

	test("every word has a dot", () => {
		for (const word of SYNC_WORDS) {
			expect(["ok", "working", "wait", "error"]).toContain(syncDot(word));
		}
	});
});

describe("the counts, which must read the same on both screens", () => {
	test("so far, until there is a total", () => {
		expect(syncCounts(412)).toBe("412 notes so far");
		expect(syncCounts(412, 1202)).toBe("412 of 1,202");
		expect(syncCounts(1)).toBe("1 note so far");
		expect(syncCounts(0)).toBe("0 notes so far");
	});

	test("no bar without a total", () => {
		expect(syncProgress(412)).toBeUndefined();
		expect(syncProgress(412, 0)).toBeUndefined();
		expect(syncProgress(412, 1202)).toBeCloseTo(412 / 1202);
		expect(syncProgress(5000, 1202)).toBe(1);
	});
});

describe("what differs between the screens, on purpose", () => {
	test("only Signed out gets a button", () => {
		expect(hasSignInButton(SIGNED_OUT)).toBe(true);
		for (const word of SYNC_WORDS.filter((w) => w !== SIGNED_OUT)) {
			expect(hasSignInButton(word)).toBe(false);
		}
	});

	test("signed out says nothing has been lost", () => {
		// The one thing somebody needs to hear before they read the word.
		expect(syncInstruction(SIGNED_OUT).toLowerCase()).toContain("still on this device");
	});

	test("up to date has nothing to instruct", () => {
		expect(syncInstruction(UP_TO_DATE)).toBe("");
	});

	test("offline says the changes are safe, and problem says nothing was lost", () => {
		expect(syncInstruction(OFFLINE).toLowerCase()).toContain("saved here");
		expect(syncInstruction(PROBLEM).toLowerCase()).toContain("nothing was lost");
	});

	test("the two unhappy dots are shared, one per response", () => {
		expect(syncDot(OFFLINE)).toBe(syncDot(PAUSED));
		expect(syncDot(PROBLEM)).toBe(syncDot(SIGNED_OUT));
		expect(syncDot(OFFLINE)).not.toBe(syncDot(PROBLEM));
	});

	test("no em-dashes in any of it", () => {
		for (const word of SYNC_WORDS) {
			expect(syncInstruction(word)).not.toContain("—");
		}
	});
});
