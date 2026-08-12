/**
 * The corner of the window, wired to the queue that does the work (#40, #41).
 *
 * `vaultStatus.test.ts` pins the rules on their own. This drives the real
 * `BackgroundSync.processSyncQueue` and the real `getFolderWork`, and reads
 * the status off the result, because the failure being kept out is a wiring
 * failure: every part was correct on its own and the status bar consulted
 * none of them.
 *
 * The state to keep out is the one from the bug report. A vault of thousands
 * of notes had every path registered on the relay and no body behind any of
 * them, and both screens said Up to date inside a minute.
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";

// Two modules jest cannot load: an ESM-only .js in this repo and an ESM-only
// build of pocketbase. Neither is on the path under test.
jest.mock("src/storage/y-indexeddb", () => ({
	IndexeddbPersistence: class {},
}));
jest.mock("pocketbase", () => ({
	__esModule: true,
	default: class {},
	BaseAuthStore: class {},
}));

import { BackgroundSync, type QueueItem } from "src/BackgroundSync";
import type { SharedFolder } from "src/SharedFolder";
import { ObservableMap } from "src/observable/ObservableMap";
import { ObservableSet } from "src/observable/ObservableSet";
import { SYNCING, UP_TO_DATE } from "src/syncStatus";
import { vaultReading } from "src/vaultStatus";

/** Let the queue's promise chain run to its end. */
const flush = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

interface Vault {
	sync: BackgroundSync;
	folder: SharedFolder;
	/** The reading both screens draw from, built the way main.ts builds it. */
	read: () => ReturnType<typeof vaultReading>;
	run: () => void;
}

/**
 * A folder whose notes are all queued, and a rule for how each one comes back.
 *
 * `wrote` decides what `syncDocument` answers for a given path: true when the
 * body went into the document, false when the sync came back without writing
 * one, which since #38 is a failure rather than a finished sync.
 */
function makeVault(paths: string[], wrote: (path: string) => boolean): Vault {
	const folder = {
		connected: true,
		shouldConnect: true,
		// The folder's own metadata document caught up straight away. That is
		// the fact the old status was built on, and on the reported vault it
		// was true within a minute of connecting.
		synced: true,
		filling: false,
	} as unknown as SharedFolder;

	const noop = () => undefined;
	const sync = Object.create(BackgroundSync.prototype) as BackgroundSync;
	const syncGroups = new ObservableMap<unknown, unknown>();
	const items: QueueItem[] = paths.map((path) => ({
		guid: path,
		path,
		doc: { path } as unknown as QueueItem["doc"],
		status: "pending",
		sharedFolder: folder,
	}));

	syncGroups.set(folder, {
		sharedFolder: folder,
		total: paths.length,
		completed: 0,
		status: "running",
		downloads: 0,
		syncs: paths.length,
		completedDownloads: 0,
		completedSyncs: 0,
	});

	Object.assign(sync, {
		debug: noop,
		log: noop,
		warn: noop,
		error: noop,
		isPaused: false,
		isProcessingSync: false,
		concurrency: 3,
		syncQueue: items,
		activeSync: new ObservableSet<unknown>(),
		syncGroups,
		inProgressSyncs: new Set<string>(paths),
		syncCompletionCallbacks: new Map(),
		timeProvider: { setTimeout: noop },
		syncDocument: (doc: { path: string }) => Promise.resolve(wrote(doc.path)),
	});

	return {
		sync,
		folder,
		read: () => {
			// Exactly what main.ts hands vaultReading for each folder.
			const work = sync.getFolderWork(folder);
			return vaultReading(true, [
				{
					shouldConnect: folder.shouldConnect,
					synced: folder.synced,
					filling: (folder as unknown as { filling: boolean }).filling,
					total: work.total,
					completed: work.completed,
				},
			]);
		},
		run: () =>
			(sync as unknown as { processSyncQueue: () => void }).processSyncQueue(),
	};
}

const notes = ["one.md", "Projects/two.md", "Projects/deep/three.md"];

describe("a first fill that registered every path and wrote no bodies", () => {
	let vault: Vault;

	beforeEach(() => {
		vault = makeVault(notes, () => false);
	});

	test("does not read Up to date, which is the whole of #40", async () => {
		vault.run();
		await flush();

		expect(vault.read().word).toBe(SYNCING);
	});

	test("counts none of them done", async () => {
		vault.run();
		await flush();

		const reading = vault.read();
		expect(reading.done).toBe(0);
		expect(reading.total).toBe(3);
	});

	test("the folder's own document being caught up does not carry it", () => {
		// Stated the way the bug presented: this is true, and it was the only
		// thing the status used to ask about.
		expect(vault.folder.synced).toBe(true);
		expect(vault.read().word).toBe(SYNCING);
	});
});

describe("a fill where one note came back without its body", () => {
	test("is not up to date, however many of the others landed", async () => {
		const vault = makeVault(notes, (path) => path !== "Projects/two.md");

		vault.run();
		await flush();

		const reading = vault.read();
		expect(reading.word).toBe(SYNCING);
		expect(reading.done).toBe(2);
		expect(reading.total).toBe(3);
		expect(reading.counts).toBe("2 of 3");
	});
});

describe("a fill where every note landed", () => {
	test("reads Up to date, and stops counting", async () => {
		const vault = makeVault(notes, () => true);

		vault.run();
		await flush();

		const reading = vault.read();
		expect(reading.word).toBe(UP_TO_DATE);
		expect(reading.done).toBe(3);
		expect(reading.counts).toBe("");
		expect(reading.progress).toBeUndefined();
	});
});

describe("what the plugin can say while it is working (#41)", () => {
	test("its own count, off its own queue, without asking a web page", async () => {
		const vault = makeVault(notes, (path) => path === "one.md");

		vault.run();
		await flush();

		const reading = vault.read();
		expect(reading.counts).toBe("1 of 3");
		expect(reading.progress).toBeCloseTo(1 / 3);
	});

	test("nothing queued yet is nothing to count, rather than 0 of 0", () => {
		const vault = makeVault([], () => true);

		const reading = vault.read();
		expect(reading.total).toBe(0);
		expect(reading.counts).toBe("");
		expect(reading.progress).toBeUndefined();
	});
});
