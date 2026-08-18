/**
 * A write to a note's file is an edit (#81, #82).
 *
 * The old rule asked whether a note's socket was open and dropped the write if
 * it was. The new rule asks whether the write already reached the Y.Text, and
 * whether the note has moved since the two sides last agreed. The second
 * question is what a conflict copy is actually for, and it is answerable on the
 * device from the Y.Doc's state vector.
 *
 * The measurement behind the middle section: on 467c04a, three Excalidraw
 * autosaves against a note whose relay copy held the previous version produced
 * three conflict copies, one per save. That is #82's twenty-one in miniature,
 * and `pins today's behaviour` below is that run kept as a test so the fix has
 * something to be measured against.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";

jest.mock("src/storage/y-indexeddb", () => ({
	IndexeddbPersistence: class {},
}));
jest.mock("pocketbase", () => ({
	__esModule: true,
	default: class {},
	BaseAuthStore: class {},
}));

import { decideCarry, stateVectorsEqual } from "src/carryDiskWrite";
import { BackgroundSync } from "src/BackgroundSync";
import { Document } from "src/Document";

const BOARD = "---\n\nkanban-plugin: board\n\n---\n\n## Todo\n\n- [ ] a\n";

describe("what a write to a note's file means", () => {
	test("a write that already reached the note is nothing to do", () => {
		expect(
			decideCarry({ crdtText: BOARD, diskText: BOARD, crdtHeldStill: false })
				.verdict,
		).toBe("noop");
	});

	test("a note that held still means the file is what it says next", () => {
		expect(
			decideCarry({
				crdtText: BOARD,
				diskText: BOARD + "- [ ] b\n",
				crdtHeldStill: true,
			}).verdict,
		).toBe("carry");
	});

	test("a note that moved means somebody else's edit arrived", () => {
		expect(
			decideCarry({
				crdtText: BOARD,
				diskText: BOARD + "- [ ] b\n",
				crdtHeldStill: false,
			}).verdict,
		).toBe("reconcile");
	});

	test("a write that takes the opening fence off a note is refused", () => {
		const decision = decideCarry({
			crdtText: BOARD,
			diskText: BOARD.slice(8),
			crdtHeldStill: true,
		});

		expect(decision.verdict).toBe("refuse");
		expect(decision.reason).toContain("frontmatter");
	});

	test("a refusal stands whether or not the note held still", () => {
		expect(
			decideCarry({
				crdtText: BOARD,
				diskText: BOARD.slice(8),
				crdtHeldStill: false,
			}).verdict,
		).toBe("refuse");
	});

	test("a write that empties a note that was not empty is refused", () => {
		expect(
			decideCarry({ crdtText: BOARD, diskText: "", crdtHeldStill: true })
				.verdict,
		).toBe("refuse");
		expect(
			decideCarry({ crdtText: BOARD, diskText: "  \n\n", crdtHeldStill: true })
				.verdict,
		).toBe("refuse");
	});

	test("filling an empty note is an ordinary edit, not a refusal", () => {
		expect(
			decideCarry({ crdtText: "", diskText: BOARD, crdtHeldStill: true })
				.verdict,
		).toBe("carry");
	});

	test("a note whose fence stays put is carried, fence and all", () => {
		expect(
			decideCarry({
				crdtText: BOARD,
				diskText: BOARD.replace("- [ ] a", "- [x] a"),
				crdtHeldStill: true,
			}).verdict,
		).toBe("carry");
	});

	test("no reason carries a path or a body", () => {
		const reasons = [
			decideCarry({ crdtText: BOARD, diskText: "", crdtHeldStill: true }),
			decideCarry({ crdtText: BOARD, diskText: BOARD + "x", crdtHeldStill: true }),
			decideCarry({ crdtText: BOARD, diskText: BOARD + "x", crdtHeldStill: false }),
		].map((d) => d.reason);

		for (const reason of reasons) {
			expect(reason).not.toContain("kanban");
			expect(reason).not.toContain(".md");
		}
	});
});

describe("comparing two state vectors", () => {
	test("a vector equals itself", () => {
		const ydoc = new Y.Doc();
		ydoc.getText("contents").insert(0, "hello");
		const vector = Y.encodeStateVector(ydoc);

		expect(stateVectorsEqual(vector, Y.encodeStateVector(ydoc))).toBe(true);
	});

	test("an edit moves it", () => {
		const ydoc = new Y.Doc();
		ydoc.getText("contents").insert(0, "hello");
		const before = Y.encodeStateVector(ydoc);
		ydoc.getText("contents").insert(5, " again");

		expect(stateVectorsEqual(before, Y.encodeStateVector(ydoc))).toBe(false);
	});

	test("nothing agreed yet is not the same as agreeing", () => {
		expect(stateVectorsEqual(undefined, undefined)).toBe(false);
	});
});

interface Rig {
	sync: BackgroundSync;
	doc: Document;
	writeConflictCopy: ReturnType<typeof jest.fn>;
	/** What is on disk right now. */
	disk: () => string;
	/** A plugin autosave: the file grows by one element. */
	write: (text: string) => void;
}

/**
 * A note whose relay copy and file start out equal, in the shape
 * `syncDocumentWebsocket` is driven in `syncDocumentOutcome.test.ts`.
 */
function makeRig(start: string): Rig {
	const ydoc = new Y.Doc();
	ydoc.getText("contents").insert(0, start);
	let disk = start;

	const writeConflictCopy = jest.fn((..._args: unknown[]) =>
		Promise.resolve("conflict.md"),
	);
	const sharedFolder = {
		relayId: "relay-onprem",
		exists: () => Promise.resolve(true),
		read: () => Promise.resolve(disk),
		writeConflictCopy,
		tokenStore: { removeFromRefreshQueue: () => undefined },
	};

	const doc = Object.create(Document.prototype) as Document;
	Object.assign(doc, {
		path: "drawing.excalidraw.md",
		guid: "doc-guid",
		ydoc,
		userLock: false,
		_parent: sharedFolder,
		_provider: { intent: "disconnected", awareness: null, ws: null },
		_ownWriteDepth: 0,
		_ownWriteUntil: 0,
		connect: () => Promise.resolve(true),
		disconnect: () => undefined,
		onceProviderSynced: () => Promise.resolve(),
	});
	Object.defineProperty(doc, "s3rn", { value: { toString: () => "s3rn" } });

	const noop = () => undefined;
	const sync = Object.create(BackgroundSync.prototype) as BackgroundSync;
	Object.assign(sync, { debug: noop, log: noop, warn: noop, error: noop });

	return {
		sync,
		doc,
		writeConflictCopy,
		disk: () => disk,
		write: (text: string) => {
			disk = text;
		},
	};
}

describe("a drawing that autosaves while its relay copy lags behind", () => {
	/**
	 * REGRESSION, measured on 467c04a: this is the run that produced three
	 * conflict copies, and #82's twenty-one over twelve minutes of drawing.
	 * They were not conflicts. Every one of them was this device's own
	 * previous autosave, preserved against an edit nobody had made.
	 */
	test("leaves no conflict copies behind", async () => {
		const rig = makeRig("round 0");
		// The two sides agree at the start, which is what a later write is
		// measured against.
		await rig.sync.syncDocumentWebsocket(rig.doc);

		for (let i = 1; i <= 3; i++) {
			rig.write(rig.disk() + `\nelement ${i}`);
			// The vault.modify patch, which sees the write as it happens.
			rig.doc.carryDiskWrite(rig.disk());
			// The periodic sync, which used to find the two sides apart.
			await rig.sync.syncDocumentWebsocket(rig.doc);
		}

		expect(rig.writeConflictCopy).not.toHaveBeenCalled();
		expect(rig.doc.ydoc.getText("contents").toJSON()).toBe(rig.disk());
	});

	/**
	 * The same three rounds with the carry step taken out, which is what the
	 * code did before this change. Kept so the fix has a measurement rather
	 * than a restatement of itself: three saves, three conflict copies.
	 */
	test("pins today's behaviour when nothing carries the write", async () => {
		const rig = makeRig("round 0");
		await rig.sync.syncDocumentWebsocket(rig.doc);

		for (let i = 1; i <= 3; i++) {
			// A build with no agreement to measure against, which is every
			// build before this one.
			Object.assign(rig.doc, { _agreedStateVector: undefined });
			rig.write(rig.disk() + `\nelement ${i}`);
			await rig.sync.syncDocumentWebsocket(rig.doc);
		}

		expect(rig.writeConflictCopy).toHaveBeenCalledTimes(3);
	});

	/**
	 * The sync path carries its own weight: even with nothing patching
	 * vault.modify, one reconcile now records an agreement, so the saves after
	 * it are carried rather than copied. Three rounds, one copy instead of
	 * three.
	 */
	test("stops the cascade after the first conflict copy", async () => {
		const rig = makeRig("round 0");
		await rig.sync.syncDocumentWebsocket(rig.doc);
		Object.assign(rig.doc, { _agreedStateVector: undefined });

		for (let i = 1; i <= 3; i++) {
			rig.write(rig.disk() + `\nelement ${i}`);
			await rig.sync.syncDocumentWebsocket(rig.doc);
		}

		expect(rig.writeConflictCopy).toHaveBeenCalledTimes(1);
		expect(rig.doc.ydoc.getText("contents").toJSON()).toBe(rig.disk());
	});

	test("still writes a conflict copy when the note actually moved", async () => {
		const rig = makeRig("round 0");
		await rig.sync.syncDocumentWebsocket(rig.doc);

		// Somebody else's edit arrives, and only then does this device save.
		rig.doc.ydoc.getText("contents").insert(0, "from another device\n");
		rig.write(rig.disk() + "\nelement 1");
		const decision = rig.doc.carryDiskWrite(rig.disk());
		expect(decision.verdict).toBe("reconcile");
		await rig.sync.syncDocumentWebsocket(rig.doc);

		expect(rig.writeConflictCopy).toHaveBeenCalledTimes(1);
	});
});

describe("a board whose serialisation drops its opening fence", () => {
	test("is left alone, on both sides", async () => {
		const rig = makeRig(BOARD);
		await rig.sync.syncDocumentWebsocket(rig.doc);

		rig.write(BOARD.slice(8));
		const decision = rig.doc.carryDiskWrite(rig.disk());

		expect(decision.verdict).toBe("refuse");
		expect(rig.doc.ydoc.getText("contents").toJSON()).toBe(BOARD);
		expect(rig.writeConflictCopy).not.toHaveBeenCalled();
	});

	test("is not reconciled either, which would be the same delete plus a file", async () => {
		const rig = makeRig(BOARD);
		await rig.sync.syncDocumentWebsocket(rig.doc);
		rig.write(BOARD.slice(8));

		const result = await rig.sync.syncDocumentWebsocket(rig.doc);

		expect(result).toBe(false);
		expect(rig.writeConflictCopy).not.toHaveBeenCalled();
		expect(rig.doc.ydoc.getText("contents").toJSON()).toBe(BOARD);
	});
});

describe("the same write arriving twice", () => {
	test("moves the note once", async () => {
		const rig = makeRig("round 0");
		await rig.sync.syncDocumentWebsocket(rig.doc);

		let updates = 0;
		rig.doc.ydoc.on("update", () => {
			updates++;
		});

		rig.write("round 0\nelement 1");
		rig.doc.carryDiskWrite(rig.disk());
		rig.doc.carryDiskWrite(rig.disk());

		expect(updates).toBe(1);
		expect(rig.doc.ydoc.getText("contents").toJSON()).toBe(rig.disk());
	});
});

describe("a note writing its own text out to its file", () => {
	test("says so while it is doing it, so the write is not carried back in", () => {
		const rig = makeRig("round 0");
		let sawOwnWrite: boolean | undefined;
		const tfile = { path: "drawing.excalidraw.md" };
		Object.assign(rig.doc, {
			_tfile: tfile,
			vault: {
				modify: () => {
					sawOwnWrite = rig.doc.isWritingOwnContent();
					return Promise.resolve();
				},
			},
			_parent: Object.assign(rig.doc.sharedFolder, {
				isPendingDelete: () => false,
			}),
			warn: () => undefined,
		});

		rig.doc.save();

		expect(sawOwnWrite).toBe(true);
		expect(rig.doc.isWritingOwnContent()).toBe(false);
	});

	test("counts the write as agreement once it lands", async () => {
		const rig = makeRig("round 0");
		Object.assign(rig.doc, {
			_tfile: { path: "drawing.excalidraw.md" },
			vault: { modify: () => Promise.resolve() },
			_parent: Object.assign(rig.doc.sharedFolder, {
				isPendingDelete: () => false,
			}),
			warn: () => undefined,
			_agreedStateVector: undefined,
		});

		expect(rig.doc.crdtHeldStill).toBe(false);
		rig.doc.save();
		await Promise.resolve();
		await Promise.resolve();

		expect(rig.doc.crdtHeldStill).toBe(true);
	});
});
