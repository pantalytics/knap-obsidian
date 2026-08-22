/**
 * The four screens nobody chose, pinned so they cannot come back.
 *
 * Each of these was a real state of the settings tab, reached by a block
 * deciding for itself whether to render. `settingsScreen.ts` has the story
 * behind each one; this file is the part that stays true.
 */

import { describe, test, expect } from "@jest/globals";
import {
	screenFor,
	showsChecklist,
	showsLinkedVault,
	showsVaultState,
	FAULT_REPORTING_NOTE,
	NOT_SYNCING_NOTE,
	NOT_SYNCING_TITLE,
	UNREACHABLE_NOTE,
	UNREACHABLE_TITLE,
	type ScreenInput,
} from "../src/settingsScreen";

const state = (over: Partial<ScreenInput> = {}): ScreenInput => ({
	signedIn: true,
	returning: true,
	linked: false,
	unreachable: false,
	...over,
});

describe("which screen the pane is showing", () => {
	test("a device that has never signed in is new, not signed out", () => {
		expect(screenFor(state({ signedIn: false, returning: false }))).toBe("new");
	});

	test("a device that has signed in before is signed out", () => {
		expect(screenFor(state({ signedIn: false }))).toBe("signedOut");
	});

	test("signed in with nothing linked is the list", () => {
		expect(screenFor(state())).toBe("choose");
	});

	test("signed in with a vault linked is the state of the sync", () => {
		expect(screenFor(state({ linked: true }))).toBe("linked");
	});

	test("a refused listing is its own screen when the list was the screen", () => {
		expect(screenFor(state({ unreachable: true }))).toBe("unreachable");
	});

	test("a vault already mounted keeps syncing when the listing fails", () => {
		// The share is mounted and moving notes. What failed is a fetch of the
		// account's vaults, which is not the same thing as the sync stopping.
		expect(screenFor(state({ unreachable: true, linked: true }))).toBe(
			"linked",
		);
	});

	test("signing out wins over anything the last fetch left behind", () => {
		expect(screenFor(state({ signedIn: false, unreachable: true }))).toBe(
			"signedOut",
		);
	});
});

describe("no state word where there is no vault to report on", () => {
	test("a fresh install says nothing about a sync it has never had", () => {
		// This is the red dot on an install where nothing had gone wrong.
		expect(showsVaultState("new")).toBe(false);
	});

	test("nor does a screen whose whole subject is that Knap did not answer", () => {
		expect(showsVaultState("unreachable")).toBe(false);
	});

	test("every screen that has a vault behind it reports on it", () => {
		expect(showsVaultState("choose")).toBe(true);
		expect(showsVaultState("linked")).toBe(true);
		expect(showsVaultState("signedOut")).toBe(true);
	});
});

describe("the list of things to sort out", () => {
	test("is on the screen with the button that starts the sync", () => {
		expect(showsChecklist("choose")).toBe(true);
	});

	test("is not shown to somebody who has been syncing for a month", () => {
		// Signing out clears the linked vault, and the list used to render on
		// exactly that.
		expect(showsChecklist("signedOut")).toBe(false);
		expect(showsChecklist("linked")).toBe(false);
	});

	test("is not shown before there is an account to link with", () => {
		expect(showsChecklist("new")).toBe(false);
	});
});

describe("the linked cloud vault", () => {
	test("survives a session ending, because the link did", () => {
		expect(showsLinkedVault("signedOut")).toBe(true);
		expect(showsLinkedVault("linked")).toBe(true);
	});

	test("is not claimed on a screen where nothing is linked", () => {
		expect(showsLinkedVault("choose")).toBe(false);
		expect(showsLinkedVault("new")).toBe(false);
	});
});

describe("the house rules for copy", () => {
	const everything = [
		NOT_SYNCING_TITLE,
		NOT_SYNCING_NOTE,
		UNREACHABLE_TITLE,
		UNREACHABLE_NOTE,
		FAULT_REPORTING_NOTE,
	];

	test("no em-dashes anywhere a person reads", () => {
		for (const line of everything) {
			expect(line).not.toContain("—");
		}
	});

	test("none of the words kept off a screen reaches one", () => {
		// ADR-0038: share, server and relay are ours, not theirs.
		for (const line of everything) {
			expect(line.toLowerCase()).not.toMatch(/\bshare\b|\brelay\b|\bserver\b/);
		}
	});

	test("the privacy line is the promise, not the inventory", () => {
		expect(FAULT_REPORTING_NOTE.toLowerCase()).toContain("never");
		expect(FAULT_REPORTING_NOTE.split(" ").length).toBeLessThan(16);
	});
});
