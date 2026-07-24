/**
 * Unit tests: findByPath + hasUnsyncedEdit (TR-42, #121a9874)
 *
 * The bug: cleanupExtraLocalFiles's trashLocal ran on any local file whose
 * path was no longer in the remote map (i.e. the remote deleted it),
 * regardless of whether the local file had edits the relay never received —
 * an offline edit racing a remote delete was silently destroyed, restorable
 * only from the OS trash if the user noticed in time.
 *
 * These two functions are the pure decision core of the fix: find the live
 * object (if any) still tracking a path, and decide whether its on-disk
 * content diverges from the last known synced content. Extracted
 * dependency-free (no Document.ts/pocketbase import — SharedFolder.ts and
 * Document.ts transitively pull in the ESM-only `pocketbase` package, which
 * breaks ts-jest parsing) so they're directly testable; verified this
 * empirically against this exact import before extracting, same as prior
 * TR-01/TR-30 extractions in this repo.
 */

import { describe, test, expect } from "@jest/globals";
import { findByPath, hasUnsyncedEdit } from "../src/preserveBeforeTrash";

describe("hasUnsyncedEdit", () => {
	test("identical content — no unsynced edit", () => {
		expect(hasUnsyncedEdit("hello world", "hello world")).toBe(false);
	});

	test("differing content — unsynced edit present", () => {
		expect(hasUnsyncedEdit("hello world, edited offline", "hello world")).toBe(
			true,
		);
	});

	test("empty vs empty — no edit", () => {
		expect(hasUnsyncedEdit("", "")).toBe(false);
	});

	test("on-disk content vs empty synced doc — treated as an edit", () => {
		// The doc never had content synced (e.g. brand-new empty Y.Text), but
		// the vault file has something — must not be silently discarded.
		expect(hasUnsyncedEdit("some local content", "")).toBe(true);
	});
});

describe("findByPath", () => {
	interface FakeThing {
		path: string;
		kind: "document" | "other";
	}

	function fake(path: string, kind: FakeThing["kind"]): FakeThing {
		return { path, kind };
	}

	const isDocumentLike = (t: FakeThing) => t.kind === "document";

	test("finds the matching value by path when the predicate matches", () => {
		const values = [
			fake("a.md", "other"),
			fake("b.md", "document"),
			fake("c.md", "document"),
		];
		const found = findByPath(values, "b.md", isDocumentLike);
		expect(found).toBe(values[1]);
	});

	test("returns undefined when no value has that path", () => {
		const values = [fake("a.md", "document")];
		expect(findByPath(values, "missing.md", isDocumentLike)).toBeUndefined();
	});

	test("returns undefined when the path matches but the predicate rejects it", () => {
		// e.g. the live object at this path is a Canvas/SyncFile, not a
		// Document — must not be mistaken for one.
		const values = [fake("a.md", "other")];
		expect(findByPath(values, "a.md", isDocumentLike)).toBeUndefined();
	});

	test("empty collection — returns undefined without throwing", () => {
		expect(findByPath([], "a.md", isDocumentLike)).toBeUndefined();
	});

	test("multiple matches at the same path — returns the LAST (most recently inserted), not the first", () => {
		// A map that's never pruned on a remote delete (SharedFolder.files)
		// can end up with a stale orphan and a live entry sharing the same
		// path after a delete-then-recreate cycle — the later insertion is
		// the live one, so returning the first match would silently compare
		// against ancient content instead.
		const stale = fake("a.md", "document");
		const live = fake("a.md", "document");
		const values = [stale, live];
		expect(findByPath(values, "a.md", isDocumentLike)).toBe(live);
	});
});
