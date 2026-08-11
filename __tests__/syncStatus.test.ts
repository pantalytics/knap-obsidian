/**
 * The four words, pinned.
 *
 * The list lives in status.py in the admin repository and this side mirrors
 * it. These assertions are the same ones its tests make, deliberately: a
 * change on one side that does not land on the other fails here, which is the
 * only mechanism two repositories have for keeping one vocabulary.
 */

import {
	SYNC_WORDS,
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

describe("the four words", () => {
	test("there are four, and these are they", () => {
		expect(SYNC_WORDS).toEqual(["Syncing", "Up to date", "Paused", "Signed out"]);
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

	test("no em-dashes in any of it", () => {
		for (const word of SYNC_WORDS) {
			expect(syncInstruction(word)).not.toContain("—");
		}
	});
});
