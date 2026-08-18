/**
 * The first fill of a JOINED vault: remote entries, empty disk (#85).
 *
 * The symptom: somebody added to an existing cloud vault linked it, the
 * folder document synced, `filemeta_v0` arrived complete -- and not one note
 * was ever downloaded, while `connected` and `synced` both read true.
 *
 * The cause was one path expression. `_handleServerCreate` runs
 * `mkdir(dirname(vpath))` for every entry that does not exist locally, and
 * `dirname` of a root-level path is ".". At vault scope "." trips the
 * dot-segment exclusion, `assertWritableVPath` throws, and that first
 * rejection took the whole folder pass of `syncFileTree` down with it, so
 * the file pass never ran at all. The owner never sees it because their
 * files already exist locally and `_handleServerCreate` is never reached.
 *
 * These tests drive the real `_handleServerCreate` and the real
 * `syncFileTree` against a real Y.Doc and a real SyncStore, with the leaves
 * that touch the vault stubbed, the same shape as firstFill.test.ts.
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";
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

import { SharedFolder } from "src/SharedFolder";
import { SyncStore } from "src/SyncStore";
import { SyncType, makeDocumentMeta, makeFolderMeta } from "src/SyncTypes";
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

interface JoinRecord {
	/** downloadDoc: a remote note was scheduled for download. */
	downloads: string[];
	/** getSyncFolder: a remote folder got its local counterpart. */
	folders: string[];
	/** vault.adapter.mkdir: a directory was actually created on disk. */
	mkdirs: string[];
}

interface Harness {
	folder: SharedFolder;
	syncStore: SyncStore;
	record: JoinRecord;
}

/**
 * A member's vault right after linking: the syncStore carries the remote
 * entries, the disk carries nothing.
 */
async function makeJoinedVault(): Promise<Harness> {
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

	const record: JoinRecord = { downloads: [], folders: [], mkdirs: [] };

	const files = new Map<string, unknown>();
	const make = (vpath: string) => {
		const guid = syncStore.get(vpath);
		const file = { path: vpath, guid };
		if (guid) files.set(guid, file);
		return file;
	};

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

		// An empty disk: nothing exists, and what mkdir is asked for is the
		// record this test reads. mkdir itself stays REAL, so the vault-scope
		// path check in assertWritableVPath is part of what is under test.
		vault: {
			getAbstractFileByPath: () => null,
			adapter: {
				mkdir: (p: string) => {
					record.mkdirs.push(p);
					return Promise.resolve();
				},
			},
		},

		isPendingDelete: () => false,
		cleanupExtraLocalFiles: () => [],

		// The leaves that would build providers or touch the network.
		downloadDoc: (vpath: string) => {
			record.downloads.push(vpath);
			return make(vpath);
		},
		downloadCanvas: (vpath: string) => make(vpath),
		downloadSyncFile: (vpath: string) => make(vpath),
		getSyncFolder: (vpath: string) => {
			record.folders.push(vpath);
			return make(vpath);
		},
	});

	return { folder, syncStore, record };
}

/** The remote tree: one folder and one note at the root, one note nested. */
function seedRemote(syncStore: SyncStore) {
	syncStore.set("Projects", makeFolderMeta("00000000-0000-4000-8000-0000000000f0"));
	syncStore.set("root.md", makeDocumentMeta("00000000-0000-4000-8000-0000000000d1"));
	syncStore.set(
		"Projects/nested.md",
		makeDocumentMeta("00000000-0000-4000-8000-0000000000d2"),
	);
}

describe("the first fill of a joined vault", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeJoinedVault();
		seedRemote(harness.syncStore);
	});

	test("a root-level note is created without asking mkdir for '.'", async () => {
		const meta = harness.syncStore.getMeta("root.md");
		expect(meta).toBeDefined();

		// Before the fix this threw "Refusing to write outside the share: .".
		await (
			harness.folder as unknown as {
				_handleServerCreate: (v: string, m: unknown) => Promise<unknown>;
			}
		)._handleServerCreate("root.md", meta);

		expect(harness.record.downloads).toEqual(["root.md"]);
		expect(harness.record.mkdirs).toEqual([]);
	});

	test("a nested note still gets its parent directory", async () => {
		const meta = harness.syncStore.getMeta("Projects/nested.md");
		await (
			harness.folder as unknown as {
				_handleServerCreate: (v: string, m: unknown) => Promise<unknown>;
			}
		)._handleServerCreate("Projects/nested.md", meta);

		expect(harness.record.downloads).toEqual(["Projects/nested.md"]);
		expect(harness.record.mkdirs).toEqual(["Projects"]);
	});

	test("syncFileTree reaches every remote entry", async () => {
		await harness.folder.syncFileTree(harness.syncStore);

		expect(harness.record.folders).toEqual(["Projects"]);
		expect(harness.record.downloads.sort()).toEqual([
			"Projects/nested.md",
			"root.md",
		]);
	});

	test("one entry that cannot be written does not silence the rest", async () => {
		// A folder whose local counterpart cannot be built, for whatever
		// reason. Before the fix the folder pass's rejection stopped
		// syncFileTree before the file pass ran, which is exactly how a
		// joined vault stayed empty behind green lights.
		(harness.folder as unknown as { getSyncFolder: unknown }).getSyncFolder =
			() => {
				throw new Error("this folder cannot be built");
			};

		await harness.folder.syncFileTree(harness.syncStore);

		expect(harness.record.downloads.sort()).toEqual([
			"Projects/nested.md",
			"root.md",
		]);
	});
});
