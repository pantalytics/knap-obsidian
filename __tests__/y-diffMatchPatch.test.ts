/**
 * Unit tests: diffMatchPatch + reconcileWithConflictCopy (TR-01, #814d6d9b)
 *
 * The bug: syncDocumentWebsocket used to call diffMatchPatch(ydoc, vaultContent)
 * unconditionally whenever the Y.Doc's synced text differed from the vault
 * file. diffMatchPatch diffs against whatever the Y.Doc CURRENTLY holds —
 * which can include another client's edits merged in moments earlier via the
 * WebSocket connect — and applies real delete ops for anything not present in
 * the vault file. Those deletes are ordinary CRDT ops: they broadcast, and
 * once GC'd they're unrecoverable. No conflict is ever surfaced.
 *
 * These tests use real Y.Doc instances (yjs is the library under test, not an
 * external boundary — mocking it would test nothing) and simulate a second
 * client's edit via Y.applyUpdate, the same mechanism a real relay sync uses.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import {
	diffMatchPatch,
	reconcileWithConflictCopy,
	alignDiffsToCodePoints,
} from "../src/y-diffMatchPatch";

function makeDocWithText(text: string): Y.Doc {
	const doc = new Y.Doc();
	doc.getText("contents").insert(0, text);
	return doc;
}

/** Simulate a second client concurrently appending `addition` and merge it in,
 * the same way a relay WebSocket sync merges a remote update. */
function mergeRemoteAppend(doc: Y.Doc, addition: string): void {
	const remote = new Y.Doc();
	Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
	remote.getText("contents").insert(
		remote.getText("contents").length,
		addition,
	);
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)));
}

describe("diffMatchPatch", () => {
	test("rewrites Y.Text to match the target string", () => {
		const doc = makeDocWithText("hello world");
		diffMatchPatch(doc, "hello there world");
		expect(doc.getText("contents").toJSON()).toBe("hello there world");
	});

	test("no-op when content already matches", () => {
		const doc = makeDocWithText("unchanged");
		diffMatchPatch(doc, "unchanged");
		expect(doc.getText("contents").toJSON()).toBe("unchanged");
	});
});

/**
 * REGRESSION: diff_main works in UTF-16 code units and will happily put a diff
 * boundary between the halves of a surrogate pair. Two emoji that share a high
 * surrogate (🍎 = D83C DF4E, 🍊 = D83C DF4A) used to come out as EQUAL "\uD83C"
 * + DELETE "\uDF4E" + INSERT "\uDF4A", leaving lone surrogates in the Y.Text.
 * That is not well-formed UTF-16, and it broadcasts as an ordinary edit, so it
 * cannot be told apart from one afterwards.
 */
describe("diffMatchPatch does not split surrogate pairs", () => {
	/** True if any surrogate survives after stripping well-formed pairs. */
	function hasLoneSurrogate(text: string): boolean {
		return /[\uD800-\uDFFF]/.test(
			text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
		);
	}

	const FRONTMATTER = "---\n\nkanban-plugin: board\n\n---\n\n";

	test("replacing an emoji with one that shares its high half", () => {
		const doc = makeDocWithText("🍎");
		diffMatchPatch(doc, "🍊");
		expect(doc.getText("contents").toJSON()).toBe("🍊");
		expect(hasLoneSurrogate(doc.getText("contents").toJSON())).toBe(false);
	});

	test("reordering two emoji cards on a board", () => {
		const before = "## 📅 Todo\n\n- [ ] 🍎 a\n- [ ] 🍊 b\n";
		const after = "## 📅 Todo\n\n- [ ] 🍊 b\n- [ ] 🍎 a\n";
		const doc = makeDocWithText(before);
		diffMatchPatch(doc, after);
		expect(doc.getText("contents").toJSON()).toBe(after);
		expect(hasLoneSurrogate(doc.getText("contents").toJSON())).toBe(false);
	});

	test("dropping an emoji from the frontmatter", () => {
		const before = "---\n\ncover: 🚀\nkanban-plugin: board\n\n---\n\n## Todo\n";
		const after = FRONTMATTER + "## Todo\n- [ ] b\n";
		const doc = makeDocWithText(before);
		diffMatchPatch(doc, after);
		expect(doc.getText("contents").toJSON()).toBe(after);
	});

	test("an ASCII edit still applies as a single minimal transaction", () => {
		const before = FRONTMATTER + "## Todo\n\n- [ ] a\n";
		const after = FRONTMATTER + "## Todo\n\n- [ ] a\n- [ ] b\n";
		const doc = makeDocWithText(before);
		let transactions = 0;
		doc.getText("contents").observe(() => transactions++);
		diffMatchPatch(doc, after);
		expect(doc.getText("contents").toJSON()).toBe(after);
		expect(transactions).toBe(1);
	});

	test("lands exactly on the target for randomised emoji-heavy text", () => {
		// Deterministic PRNG so any failure is reproducible from the seed.
		let seed = 1337;
		const rnd = () =>
			(seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		const alphabet = [
			"a", "b", "\n", "- [ ] ", "## ", "🍎", "🍊", "📅", "🚀", "é", "---",
		];
		const gen = (n: number) =>
			Array.from(
				{ length: n },
				() => alphabet[Math.floor(rnd() * alphabet.length)],
			).join("");

		for (let i = 0; i < 500; i++) {
			const after = FRONTMATTER + gen(Math.floor(rnd() * 40));
			const doc = makeDocWithText(FRONTMATTER + gen(Math.floor(rnd() * 40)));
			diffMatchPatch(doc, after);
			const result = doc.getText("contents").toJSON();
			expect(result).toBe(after);
			expect(hasLoneSurrogate(result)).toBe(false);
		}
	});

	test("alignDiffsToCodePoints keeps both sides of the diff spelling the right text", () => {
		const aligned = alignDiffsToCodePoints([
			[0, "\uD83C"],
			[-1, "\uDF4E"],
			[1, "\uDF4A"],
		]);

		const oldText = aligned
			.filter(([op]) => op !== 1)
			.map(([, text]) => text)
			.join("");
		const newText = aligned
			.filter(([op]) => op !== -1)
			.map(([, text]) => text)
			.join("");

		expect(oldText).toBe("🍎");
		expect(newText).toBe("🍊");
		expect(aligned.every(([, text]) => !hasLoneSurrogate(text))).toBe(true);
	});

	test("alignDiffsToCodePoints leaves ASCII diffs untouched", () => {
		const diffs: [number, string][] = [
			[0, "## Todo\n"],
			[1, "- [ ] b\n"],
		];
		expect(alignDiffsToCodePoints([...diffs])).toEqual(diffs);
	});
});

describe("reconcileWithConflictCopy", () => {
	test("does nothing and writes no conflict copy when content already matches", async () => {
		const doc = makeDocWithText("same content");
		const writer = jest.fn<() => Promise<string>>().mockResolvedValue("x");

		const result = await reconcileWithConflictCopy(doc, "same content", writer);

		expect(result.reconciled).toBe(false);
		expect(result.conflictPath).toBeUndefined();
		expect(writer).not.toHaveBeenCalled();
		expect(doc.getText("contents").toJSON()).toBe("same content");
	});

	test("on plain divergence: preserves old content via writer, then reconciles to vault content", async () => {
		const doc = makeDocWithText("device A's local edit");
		const writer = jest
			.fn<(content: string) => Promise<string>>()
			.mockResolvedValue("notes/file (conflict).md");

		const result = await reconcileWithConflictCopy(
			doc,
			"vault file content",
			writer,
		);

		expect(writer).toHaveBeenCalledTimes(1);
		expect(writer).toHaveBeenCalledWith("device A's local edit");
		expect(result.reconciled).toBe(true);
		expect(result.conflictPath).toBe("notes/file (conflict).md");
		expect(doc.getText("contents").toJSON()).toBe("vault file content");
	});

	test("REGRESSION (TR-01): another client's merged edit is captured by the conflict copy before being overwritten, never silently discarded", async () => {
		// Simulates: doc starts with base content, a second client concurrently
		// appends " [edit from client B]" and it merges in via the relay
		// WebSocket sync — exactly what happens right before the destructive
		// reconciliation used to run in syncDocumentWebsocket.
		const doc = makeDocWithText("shared base content");
		mergeRemoteAppend(doc, " [edit from client B]");
		expect(doc.getText("contents").toJSON()).toBe(
			"shared base content [edit from client B]",
		);

		// The LOCAL vault file is stale — it never saw client B's edit.
		const staleVaultContent = "shared base content";

		let capturedBeforeOverwrite = "";
		const writer = jest
			.fn<(content: string) => Promise<string>>()
			.mockImplementation(async (content) => {
				capturedBeforeOverwrite = content;
				return "shared base content (relay conflict).md";
			});

		const result = await reconcileWithConflictCopy(
			doc,
			staleVaultContent,
			writer,
		);

		// Client B's edit is GONE from the live doc (existing vault-wins
		// behavior is preserved) — but it was captured first, not lost.
		expect(doc.getText("contents").toJSON()).toBe(staleVaultContent);
		expect(capturedBeforeOverwrite).toBe(
			"shared base content [edit from client B]",
		);
		expect(capturedBeforeOverwrite).toContain("[edit from client B]");
		expect(result.reconciled).toBe(true);
		expect(result.conflictPath).toBe(
			"shared base content (relay conflict).md",
		);
	});

	test("fails closed: if the conflict-copy write throws, the Y.Doc is left untouched", async () => {
		const doc = makeDocWithText("content that must not vanish");
		const writer = jest
			.fn<() => Promise<string>>()
			.mockRejectedValue(new Error("disk full"));
		const log = jest.fn();

		const result = await reconcileWithConflictCopy(
			doc,
			"different vault content",
			writer,
			undefined,
			log,
		);

		expect(result.reconciled).toBe(false);
		expect(result.conflictPath).toBeUndefined();
		// The Y.Doc must be UNCHANGED — this is the fail-closed guarantee.
		expect(doc.getText("contents").toJSON()).toBe(
			"content that must not vanish",
		);
		expect(log).toHaveBeenCalled();
	});

	test("passes origin through to the underlying transact (so it's attributable, same as before)", async () => {
		const doc = makeDocWithText("old");
		const origins: unknown[] = [];
		doc.on("afterTransaction", (tr: Y.Transaction) => {
			origins.push(tr.origin);
		});
		const writer = jest.fn<() => Promise<string>>().mockResolvedValue("path");
		const marker = Symbol("test-origin");

		await reconcileWithConflictCopy(doc, "new", writer, marker);

		expect(origins).toContain(marker);
	});
});
