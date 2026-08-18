/**
 * A file tree entry that fails every pass reports a fault (#89, ADR-0071).
 *
 * Since #88 a rejected entry no longer takes the whole pass down: it is
 * warned about and skipped, and the next pass retries it. That keeps a
 * joined vault filling, and it still leaves the one failure mode that
 * empties a vault reporting nothing to anybody who could fix it. The only
 * faults production saw during #85 were `component=tokens`, three steps
 * removed from the cause.
 *
 * Two things are under test here. The folding, in `syncFaults.ts`: one
 * transient failure is nobody's business, the same entry failing again is.
 * And the wire, driving the real `syncFileTree` through the real fault
 * reporter: what arrives at /faults carries the error's type and never the
 * path of the entry that failed.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import * as Y from "yjs";

// Obsidian ships Array.prototype.contains; syncByType leans on it.
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

import { requestUrl } from "obsidian";
import { RepeatedEntryFailures, REPEATED_AFTER_PASSES } from "src/syncFaults";
import { SEND_EVERY_MS, setFaultReporting } from "src/faults";
import { SharedFolder } from "src/SharedFolder";
import { SyncStore } from "src/SyncStore";
import { makeDocumentMeta, makeFolderMeta } from "src/SyncTypes";
import {
	NamespacedSettings,
	Settings,
	type StorageAdapter,
} from "src/SettingsStorage";
import { SyncSettingsManager, type SyncFlags } from "src/SyncSettings";

const requestUrlMock = requestUrl as jest.Mock;

class MemoryStorage implements StorageAdapter<unknown> {
	private data: unknown = null;
	async loadData(): Promise<unknown> {
		return this.data;
	}
	async saveData(data: unknown): Promise<void> {
		this.data = data;
	}
}

describe("repeated entry failures", () => {
	test("one bad pass is nobody's business", () => {
		const reported: unknown[] = [];
		const streaks = new RepeatedEntryFailures((e) => reported.push(e));

		streaks.pass([{ path: "Dailies/2026-08-11.md", error: new Error("busy") }]);

		expect(reported).toHaveLength(0);
		expect(streaks.failing).toBe(1);
	});

	test("the same entry failing again is", () => {
		const reported: unknown[] = [];
		const streaks = new RepeatedEntryFailures((e) => reported.push(e));
		const failing = [{ path: "root.md", error: new TypeError("no") }];

		streaks.pass(failing);
		streaks.pass(failing);

		expect(reported).toHaveLength(1);
		expect(reported[0]).toBeInstanceOf(TypeError);
	});

	test("two passes is the threshold, and it is the smallest one that means again", () => {
		expect(REPEATED_AFTER_PASSES).toBe(2);
	});

	test("an entry that stops failing is forgotten rather than kept waiting", () => {
		const reported: unknown[] = [];
		const streaks = new RepeatedEntryFailures((e) => reported.push(e));

		streaks.pass([{ path: "a.md", error: new Error("once") }]);
		streaks.pass([]); // the retry worked
		streaks.pass([{ path: "a.md", error: new Error("again, much later") }]);

		expect(reported).toHaveLength(0);
		expect(streaks.failing).toBe(1);
	});

	test("one entry failing twice inside one pass is not a streak", () => {
		// A folder create is awaited on its own and again with the file
		// creates, so a bad folder rejects twice in the same pass. That is
		// one entry failing once.
		const reported: unknown[] = [];
		const streaks = new RepeatedEntryFailures((e) => reported.push(e));

		streaks.pass([
			{ path: "Projects", error: new Error("first") },
			{ path: "Projects", error: new Error("second") },
		]);

		expect(reported).toHaveLength(0);
		expect(streaks.failing).toBe(1);
	});

	test("it keeps reporting while the entry keeps failing", () => {
		const reported: unknown[] = [];
		const streaks = new RepeatedEntryFailures((e) => reported.push(e));
		const failing = [{ path: "root.md", error: new Error("still no") }];

		streaks.pass(failing);
		streaks.pass(failing);
		streaks.pass(failing);
		streaks.pass(failing);

		expect(reported).toHaveLength(3);
	});

	test("entries are counted apart, so one broken note does not report another", () => {
		const reported: unknown[] = [];
		const streaks = new RepeatedEntryFailures((e) => reported.push(e));

		streaks.pass([{ path: "a.md", error: new Error("a") }]);
		streaks.pass([
			{ path: "a.md", error: new Error("a") },
			{ path: "b.md", error: new Error("b") },
		]);

		// a.md is on its second pass, b.md on its first.
		expect(reported).toHaveLength(1);
		expect(streaks.failing).toBe(2);
	});
});

/**
 * A member's vault right after linking, the same shape joinFill.test.ts
 * uses: the syncStore carries the remote entries, the disk carries nothing.
 * One entry is rigged to fail on every pass.
 */
async function makeVaultWithABadEntry(): Promise<{
	folder: SharedFolder;
	syncStore: SyncStore;
	downloads: string[];
}> {
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
	syncStore.set(
		"Projects",
		makeFolderMeta("00000000-0000-4000-8000-0000000000f0"),
	);
	syncStore.set(
		"Clients/Acme/2026 renewal.md",
		makeDocumentMeta("00000000-0000-4000-8000-0000000000d1"),
	);

	const downloads: string[] = [];
	const files = new Map<string, unknown>();
	const noop = () => undefined;

	const folder = Object.create(SharedFolder.prototype) as SharedFolder;
	Object.assign(folder, {
		scope: "vault",
		path: "",
		ydoc,
		syncStore,
		files,
		fset: { add: jest.fn(), update: jest.fn() },
		pendingDeletes: new Set<string>(),
		_filling: false,
		syncFileTreePromise: null,
		syncRequestedDuringSync: false,
		obsidianApp: { vault: { configDir: ".obsidian" } },
		debug: noop,
		log: noop,
		warn: noop,
		error: noop,
		vault: {
			getAbstractFileByPath: () => null,
			adapter: { mkdir: () => Promise.resolve() },
		},
		isPendingDelete: () => false,
		cleanupExtraLocalFiles: () => [],
		// The note whose name must never leave the device fails every time.
		downloadDoc: (vpath: string) => {
			throw new Error(`ENOENT: ${vpath} could not be written`);
		},
		downloadCanvas: () => undefined,
		downloadSyncFile: () => undefined,
		getSyncFolder: (vpath: string) => {
			downloads.push(vpath);
			const guid = syncStore.get(vpath);
			const file = { path: vpath, guid };
			if (guid) files.set(guid, file);
			return file;
		},
	});

	return { folder, syncStore, downloads };
}

describe("a syncFileTree entry that fails every pass", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		requestUrlMock.mockReset();
		requestUrlMock.mockResolvedValue({ status: 204 });
		setFaultReporting(true);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("says nothing after one pass", async () => {
		const { folder, syncStore } = await makeVaultWithABadEntry();

		await folder.syncFileTree(syncStore);
		await jest.advanceTimersByTimeAsync(SEND_EVERY_MS * 2);

		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	test("reaches /faults after it fails again, and carries no path", async () => {
		const { folder, syncStore, downloads } = await makeVaultWithABadEntry();

		await folder.syncFileTree(syncStore);
		await folder.syncFileTree(syncStore);
		await jest.advanceTimersByTimeAsync(SEND_EVERY_MS * 2);

		expect(requestUrlMock).toHaveBeenCalledTimes(1);
		const params = requestUrlMock.mock.calls[0][0] as {
			url: string;
			body: string;
		};
		expect(params.url).toBe("https://knap.test/faults");

		const payload = JSON.parse(params.body) as {
			faults: Record<string, unknown>[];
		};
		expect(payload.faults).toHaveLength(1);
		expect(payload.faults[0]).toMatchObject({
			component: "sync",
			type: "Error",
		});

		// ADR-0071, and the whole point of the exercise: the entry that
		// failed is named nowhere on the wire.
		expect(params.body).not.toContain("Acme");
		expect(params.body).not.toContain("renewal");
		expect(params.body).not.toContain(".md");
		expect(params.body).not.toContain("Clients");
		expect(params.body).not.toContain("ENOENT");

		// And the pass itself kept going, which is #88's half of this.
		expect(downloads).toEqual(["Projects", "Projects"]);
	});

	test("says nothing at all when fault reporting is off", async () => {
		const { folder, syncStore } = await makeVaultWithABadEntry();
		setFaultReporting(false);

		await folder.syncFileTree(syncStore);
		await folder.syncFileTree(syncStore);
		await jest.advanceTimersByTimeAsync(SEND_EVERY_MS * 2);

		expect(requestUrlMock).not.toHaveBeenCalled();
		setFaultReporting(true);
	});
});
