/**
 * The notes a first fill leaves empty (#56).
 *
 * Measured on a real vault of 2582 notes: the fill ran to 2576 and stopped.
 * Four of the six left over had content on disk and nothing on the relay,
 * still nothing sixteen minutes and a full scrub later, and the plugin
 * reported itself done the whole time. Opening one by hand fixed it inside a
 * minute. The sixth was `Anaïs' dagboek.md`, 0 bytes on disk and correctly 0
 * bytes on the relay, and it is the one that must never be retried.
 *
 * The sweep is the same offer opening the note makes, without the hand. What
 * these tests hold it to: it offers what has bytes here and nothing there, it
 * leaves an empty file alone however many rounds run, and it stops.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import * as Y from "yjs";

if (!Array.prototype.contains) {
	Object.defineProperty(Array.prototype, "contains", {
		value: function (item: unknown) {
			return this.includes(item);
		},
	});
}

jest.mock("src/storage/y-indexeddb", () => ({
	IndexeddbPersistence: class {},
}));
jest.mock("pocketbase", () => ({
	__esModule: true,
	default: class {},
	BaseAuthStore: class {},
}));

import { TFile } from "obsidian";
import {
	sweepEmptyDocs,
	SWEEP_WAITS_MS,
	type SweepDeps,
} from "src/emptyDocSweep";
import { Document } from "src/Document";
import { SharedFolder } from "src/SharedFolder";
import { SyncStore } from "src/SyncStore";
import { makeDocumentMeta, makeFolderMeta } from "src/SyncTypes";
import {
	NamespacedSettings,
	Settings,
	type StorageAdapter,
} from "src/SettingsStorage";
import { SyncSettingsManager, type SyncFlags } from "src/SyncSettings";

class MemoryStorage implements StorageAdapter<unknown> {
	private data: unknown = null;
	async loadData(): Promise<unknown> {
		return this.data;
	}
	async saveData(data: unknown): Promise<void> {
		this.data = data;
	}
}

/**
 * A share as the sweep sees it: which notes are empty on the relay and how
 * big each one is on disk. Both answers can change between rounds, which is
 * what makes a round worth running.
 */
function fakeShare(state: {
	empty: string[];
	bytes: Record<string, number>;
}) {
	const offered: string[] = [];
	const waited: number[] = [];
	const logged: string[] = [];
	const deps: SweepDeps = {
		empty: () => [...state.empty],
		localBytes: (vpath) => state.bytes[vpath] ?? 0,
		offer: (vpath) => offered.push(vpath),
		wait: (ms) => {
			waited.push(ms);
			return Promise.resolve();
		},
		log: (message) => logged.push(message),
	};
	return { deps, offered, waited, logged, state };
}

describe("the sweep over the notes a fill leaves empty", () => {
	test("offers a note that has bytes here and nothing on the relay", async () => {
		const share = fakeShare({
			empty: ["Dailies/2023-04-02.md"],
			bytes: { "Dailies/2023-04-02.md": 123 },
		});

		const report = await sweepEmptyDocs(share.deps, [1]);

		expect(share.offered).toEqual(["Dailies/2023-04-02.md"]);
		expect(report.offered).toBe(1);
	});

	test("leaves a note that is empty on disk alone, in every round", async () => {
		// Anaïs' dagboek. Nothing to upload, and no round at which offering
		// it starts working.
		const share = fakeShare({
			empty: ["Anaïs' dagboek.md"],
			bytes: { "Anaïs' dagboek.md": 0 },
		});

		const report = await sweepEmptyDocs(share.deps, [1, 1, 1]);

		expect(share.offered).toEqual([]);
		expect(report.offered).toBe(0);
		// Nothing to do is the same as being finished: it stops on round one
		// rather than waiting out the schedule for a file that is fine.
		expect(report.rounds).toBe(1);
	});

	test("leaves a note that is not on this disk at all alone", async () => {
		// A joined vault downloading: empty here because it has not arrived,
		// which is somebody else's half of the exchange.
		const share = fakeShare({ empty: ["inbound.md"], bytes: {} });

		await sweepEmptyDocs(share.deps, [1, 1]);

		expect(share.offered).toEqual([]);
	});

	test("waits before it looks, rather than judging a fill that is still running", async () => {
		const share = fakeShare({ empty: ["a.md"], bytes: { "a.md": 10 } });

		await sweepEmptyDocs(share.deps, [60_000]);

		expect(share.waited).toEqual([60_000]);
	});

	test("stops as soon as there is nothing left to offer", async () => {
		const share = fakeShare({ empty: ["a.md"], bytes: { "a.md": 10 } });
		const original = share.deps.offer;
		share.deps.offer = (vpath) => {
			original(vpath);
			// The offer landed: the note is no longer empty.
			share.state.empty = [];
		};

		const report = await sweepEmptyDocs(share.deps, [1, 1, 1]);

		expect(share.offered).toEqual(["a.md"]);
		expect(report.rounds).toBe(2);
		expect(report.stillEmpty).toBe(0);
	});

	test("gives up rather than sweeping forever", async () => {
		// A note that never fills, whatever is offered.
		const share = fakeShare({ empty: ["stuck.md"], bytes: { "stuck.md": 99 } });

		const report = await sweepEmptyDocs(share.deps, [1, 1, 1]);

		expect(report.rounds).toBe(3);
		expect(share.offered).toHaveLength(3);
		expect(report.stillEmpty).toBe(1);
		expect(share.logged.join("\n")).toContain("out of rounds");
	});

	test("the shipped schedule is three rounds and stretches out", async () => {
		expect(SWEEP_WAITS_MS).toHaveLength(3);
		const rising = SWEEP_WAITS_MS.every(
			(ms, i) => i === 0 || ms > SWEEP_WAITS_MS[i - 1],
		);
		expect(rising).toBe(true);
	});
});

/** A Document that is real enough for instanceof and for `text`. */
function documentAt(vpath: string, guid: string, contents: string): Document {
	const doc = Object.create(Document.prototype) as Document;
	const ydoc = new Y.Doc();
	if (contents) {
		ydoc.getText("contents").insert(0, contents);
	}
	Object.assign(doc, { path: vpath, guid, ydoc });
	return doc;
}

interface ShareHarness {
	folder: SharedFolder;
	enqueueSync: jest.Mock;
	sweep: () => Promise<void>;
}

/**
 * A share right after a fill: three notes on the relay, one of which never
 * got its body across, plus a note that is empty on both sides.
 */
async function makeSweptShare(): Promise<ShareHarness> {
	const ydoc = new Y.Doc();
	const settings = new Settings(new MemoryStorage(), {});
	const namespaced = new NamespacedSettings<{ sync: SyncFlags }>(
		settings as unknown as Settings<unknown>,
		"sync",
	);
	const syncSettingsManager = namespaced.getChild<
		Record<keyof SyncFlags, boolean>,
		SyncSettingsManager
	>("sync", (child, path) => new SyncSettingsManager(child, path));
	await settings.load();

	const syncStore = new SyncStore(
		ydoc,
		"",
		new Map<string, string>(),
		syncSettingsManager,
	);

	const guids = {
		stranded: "00000000-0000-4000-8000-0000000000d1",
		fine: "00000000-0000-4000-8000-0000000000d2",
		blank: "00000000-0000-4000-8000-0000000000d3",
	};
	syncStore.set("Dailies/2023-04-02.md", makeDocumentMeta(guids.stranded));
	syncStore.set("Dailies/2024-05-17.md", makeDocumentMeta(guids.fine));
	syncStore.set("Anaïs' dagboek.md", makeDocumentMeta(guids.blank));
	syncStore.set("Dailies", makeFolderMeta("00000000-0000-4000-8000-0000000000f0"));

	const files = new Map<string, unknown>();
	files.set(
		guids.stranded,
		documentAt("Dailies/2023-04-02.md", guids.stranded, ""),
	);
	files.set(
		guids.fine,
		documentAt("Dailies/2024-05-17.md", guids.fine, "this one made it"),
	);
	files.set(guids.blank, documentAt("Anaïs' dagboek.md", guids.blank, ""));

	// What is on disk. The stranded note has bytes, the diary does not.
	const sizes: Record<string, number> = {
		"Dailies/2023-04-02.md": 123,
		"Dailies/2024-05-17.md": 739,
		"Anaïs' dagboek.md": 0,
	};

	const enqueueSync = jest.fn();
	const noop = () => undefined;
	const folder = Object.create(SharedFolder.prototype) as SharedFolder;
	Object.assign(folder, {
		scope: "vault",
		path: "",
		ydoc,
		syncStore,
		files,
		destroyed: false,
		sweeping: false,
		fset: { add: jest.fn(), update: jest.fn() },
		debug: noop,
		log: noop,
		warn: noop,
		error: noop,
		backgroundSync: { enqueueSync },
		vault: {
			getAbstractFileByPath: (path: string) => {
				if (!(path in sizes)) return null;
				const tfile = new TFile(path);
				tfile.stat.size = sizes[path];
				return tfile;
			},
		},
	});

	return {
		folder,
		enqueueSync,
		sweep: () =>
			(
				folder as unknown as { startEmptyDocSweep: () => Promise<void> }
			).startEmptyDocSweep(),
	};
}

describe("a share sweeping its own empty notes", () => {
	let harness: ShareHarness;

	beforeEach(async () => {
		jest.useFakeTimers();
		harness = await makeSweptShare();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	/** Run the whole schedule out. Nothing here fills a note, so it does. */
	async function sweepToTheEnd(): Promise<string[]> {
		const done = harness.sweep();
		await jest.advanceTimersByTimeAsync(
			SWEEP_WAITS_MS.reduce((a, b) => a + b, 0) + 10,
		);
		await done;
		return harness.enqueueSync.mock.calls.map(
			(call) => (call[0] as Document).path,
		);
	}

	test("offers the note that has bytes here and nothing on the relay", async () => {
		const offered = await sweepToTheEnd();

		expect(offered.length).toBeGreaterThan(0);
		expect(new Set(offered)).toEqual(new Set(["Dailies/2023-04-02.md"]));
	});

	test("never offers the note that is empty on both sides", async () => {
		const offered = await sweepToTheEnd();

		expect(offered).not.toContain("Anaïs' dagboek.md");
	});

	test("never offers the note that already made it across", async () => {
		const offered = await sweepToTheEnd();

		expect(offered).not.toContain("Dailies/2024-05-17.md");
	});

	test("offers a stuck note once per round and then stops", async () => {
		const offered = await sweepToTheEnd();

		expect(offered).toHaveLength(SWEEP_WAITS_MS.length);
	});

	test("a share that is torn down mid-wait stops instead of hanging", async () => {
		const done = harness.sweep();
		await jest.advanceTimersByTimeAsync(1000);

		(harness.folder as unknown as { destroyed: boolean }).destroyed = true;
		const wake = (harness.folder as unknown as { sweepWake?: () => void })
			.sweepWake;
		expect(wake).toBeDefined();
		wake?.();

		await done;
		expect(harness.enqueueSync).not.toHaveBeenCalled();
	});
});
