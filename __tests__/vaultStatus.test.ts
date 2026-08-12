/**
 * The word behind the mark in the status bar.
 *
 * The four words themselves are pinned in syncStatus.test.ts. What is tested
 * here is the step in front of them: which folders make a vault paused, which
 * make it syncing, and which leave it green. The icon in the corner is the
 * only place most people ever read this, so a folder that quietly reports the
 * wrong one is a vault somebody thinks is safe.
 */

import { PAUSED, SIGNED_OUT, SYNCING, UP_TO_DATE } from "../src/syncStatus";
import { SYNC_DOT_NAMES, vaultSyncWord } from "../src/vaultStatus";

const synced = { shouldConnect: true, synced: true };
const behind = { shouldConnect: true, synced: false };
const off = { shouldConnect: false, synced: true };

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
