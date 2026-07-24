/**
 * Tests for the pure nested-share conflict check (TR-30).
 *
 * Relay does not support nested shares: two SharedFolders covering
 * overlapping files (e.g. share "A", then share "A/B") race on which one
 * processes a given file, non-deterministically.
 */

import { describe, test, expect } from "@jest/globals";
import { findNestingConflictPath } from "../src/sharedFolderNesting";

const SEP = "/";

describe("findNestingConflictPath", () => {
	test("returns null when there are no existing shares", () => {
		expect(findNestingConflictPath("A", [], SEP)).toBeNull();
	});

	test("returns null for an unrelated, non-overlapping path", () => {
		expect(findNestingConflictPath("C", ["A", "B"], SEP)).toBeNull();
	});

	test("detects sharing a direct subfolder of an existing share", () => {
		expect(findNestingConflictPath("A/B", ["A"], SEP)).toBe("A");
	});

	test("detects sharing a deeply nested subfolder of an existing share", () => {
		expect(findNestingConflictPath("A/B/C/D", ["A"], SEP)).toBe("A");
	});

	test("detects sharing a folder that already contains an existing share", () => {
		expect(findNestingConflictPath("A", ["A/B"], SEP)).toBe("A/B");
	});

	test("detects the ancestor case even when a deeper existing share is involved", () => {
		expect(findNestingConflictPath("A", ["A/B/C"], SEP)).toBe("A/B/C");
	});

	test("does NOT treat a sibling with a shared name prefix as nested", () => {
		// "AB" is not nested under "A" -- must require the separator boundary
		expect(findNestingConflictPath("AB", ["A"], SEP)).toBeNull();
		expect(findNestingConflictPath("A", ["AB"], SEP)).toBeNull();
	});

	test("exact path match is not itself a nesting conflict (handled separately as samePath)", () => {
		expect(findNestingConflictPath("A", ["A"], SEP)).toBeNull();
	});

	test("returns the first conflicting share when multiple exist", () => {
		expect(findNestingConflictPath("A/B", ["A", "X"], SEP)).toBe("A");
	});

	test("checks against every existing share, not just the first", () => {
		expect(findNestingConflictPath("X/Y", ["A", "X"], SEP)).toBe("X");
	});
});
