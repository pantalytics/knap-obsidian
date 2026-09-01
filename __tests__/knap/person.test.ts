/**
 * What a colleague is called on a caret and in a conflict copy's name.
 *
 * Both labels named a machine before two people shared a vault: the caret
 * carried the device name, and the conflict copy carried nothing but a date,
 * so two people conflicting on one note on one day produced the same filename
 * twice.
 */

import { conflictLabelFor, personLabel } from "../../src/knap/person";

describe("personLabel", () => {
	test("an address becomes the part a colleague recognises", () => {
		expect(personLabel("daniel@pantalytics.com", "MacBook-Pro-2")).toBe("daniel");
	});

	test("the device name is the fallback, not the answer", () => {
		// An account whose issuer returned no address is a real case: the
		// server keeps one address per account and it is empty until a
		// sign-in fills it.
		expect(personLabel("", "MacBook-Pro-2")).toBe("MacBook-Pro-2");
	});

	test("whitespace is not an address", () => {
		expect(personLabel("   ", "Laptop")).toBe("Laptop");
		expect(personLabel("  @pantalytics.com", "Laptop")).toBe("Laptop");
	});

	test("something is always shown, because a nameless caret names nobody", () => {
		expect(personLabel("", "")).toBe("Someone else");
	});

	test("an address is trimmed and its domain dropped", () => {
		// Three times the width on a caret, and the same domain for everybody
		// in the vault anyway.
		expect(personLabel(" Rutger@pantalytics.com ", "x")).toBe("Rutger");
	});
});

describe("conflictLabelFor", () => {
	const on = new Date("2026-09-01T11:20:00Z");

	test("says who made it and when", () => {
		expect(conflictLabelFor("daniel@pantalytics.com", "MacBook", on)).toBe(
			"daniel conflict 2026-09-01",
		);
	});

	test("two people on one note on one day no longer collide", () => {
		const mine = conflictLabelFor("rutger@pantalytics.com", "MacBook", on);
		const theirs = conflictLabelFor("daniel@pantalytics.com", "ThinkPad", on);
		expect(mine).not.toBe(theirs);
	});

	test("without an address it falls back to the device, still not to the bare date", () => {
		expect(conflictLabelFor("", "MacBook", on)).toBe("MacBook conflict 2026-09-01");
	});
});
