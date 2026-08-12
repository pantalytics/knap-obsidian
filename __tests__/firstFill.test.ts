/**
 * The first fill over a vault that already has notes (#38, #27).
 *
 * The symptom these cover: connecting a vault full of notes registered every
 * path on the relay and wrote no bodies. Every document came out 0 bytes, and
 * the plugin said it was up to date.
 *
 * The cause was the order of two operations in `addLocalDocs`.
 * `ensureFileMetadata` writes a `filemeta_v0` entry for every markdown file
 * before the walk starts. The walk then asked `getFile()` whether the file
 * already existed, and `getFile()` is not a question: it reads the entry
 * `ensureFileMetadata` just wrote and creates the missing Document as a side
 * effect. So the walk saw every note as "already handled" on the very first
 * pass, and `uploadDoc` -- the only thing in SharedFolder that copies a note's
 * bytes into its Y.Text -- was never reached.
 *
 * These tests drive the real `addLocalDocs`, `placeHold`, `ensureFileMetadata`
 * and `getFile` against a real Y.Doc and a real SyncStore. Only the leaves
 * that build a Document or touch the vault are stubbed, and each stub records
 * which of the two things happened to a note: its body was seeded from disk,
 * or its path was registered and the body left to somebody else. A first fill
 * that registers everything and seeds nothing is the bug.
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import * as Y from "yjs";

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

import { TFile, TFolder } from "obsidian";
import { SharedFolder, SharedFolders } from "src/SharedFolder";
import type { SharedFolderSettings } from "src/SharedFolder";
import { SyncStore } from "src/SyncStore";
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

/** What happened to each note during the fill. */
interface FillRecord {
	/** uploadDoc: the note's body was copied from disk into its Y.Text. */
	seeded: string[];
	/** getDoc: the note's path was registered, the body left to somebody else. */
	attached: string[];
	/** adoptWinnerDoc: another client won the race for this path. */
	adopted: string[];
	folders: string[];
	syncFiles: string[];
	uploadedFiles: string[];
}

interface Harness {
	folder: SharedFolder;
	syncStore: SyncStore;
	record: FillRecord;
	/** Run addLocalDocs, which is private. */
	fill: () => Promise<void>;
}

async function makeVault(paths: string[]): Promise<Harness> {
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

	const record: FillRecord = {
		seeded: [],
		attached: [],
		adopted: [],
		folders: [],
		syncFiles: [],
		uploadedFiles: [],
	};

	const files = new Map<string, unknown>();
	const make = (vpath: string) => {
		const guid = syncStore.get(vpath);
		if (!guid) {
			throw new Error(`no guid for ${vpath}`);
		}
		const file = { path: vpath, guid };
		files.set(guid, file);
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
		obsidianApp: { vault: { configDir: ".obsidian" } },
		debug: noop,
		log: noop,
		warn: noop,
		error: noop,

		// The vault, as the walk sees it.
		getSyncFiles: () => paths.map((p) => new TFile(p)),

		// No second client in these tests. The claim protocol has its own
		// coverage in uploadClaim.test.ts.
		claimUploadPaths: async () => ({ won: paths, lost: [] }),

		// The leaves. Each one stands for one of the two outcomes a note can
		// have, and records which it got.
		uploadDoc: (vpath: string) => {
			record.seeded.push(vpath);
			return make(vpath);
		},
		getDoc: (vpath: string) => {
			record.attached.push(vpath);
			return make(vpath);
		},
		adoptWinnerDoc: (vpath: string) => {
			record.adopted.push(vpath);
			return Promise.resolve(make(vpath));
		},
		getSyncFolder: (vpath: string) => {
			record.folders.push(vpath);
			return make(vpath);
		},
		syncFile: (vpath: string) => {
			record.syncFiles.push(vpath);
			return make(vpath);
		},
		uploadSyncFile: (vpath: string) => {
			record.uploadedFiles.push(vpath);
			return make(vpath);
		},
	});

	return {
		folder,
		syncStore,
		record,
		fill: () =>
			(folder as unknown as { addLocalDocs: () => Promise<void> }).addLocalDocs(),
	};
}

const notes = ["one.md", "Projects/two.md", "Projects/deep/three.md"];

describe("the first fill over a vault that already has notes", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeVault(notes);
	});

	test("every note's body is seeded from disk", async () => {
		await harness.fill();

		expect(harness.record.seeded.sort()).toEqual([...notes].sort());
	});

	test("no note is registered without its body being written", async () => {
		await harness.fill();

		// The bug in one assertion: a note that took the attach path on a
		// first fill is a path on the relay with nothing behind it.
		expect(harness.record.attached).toEqual([]);
	});

	test("every note still gets its metadata entry", async () => {
		await harness.fill();

		for (const note of notes) {
			expect(harness.syncStore.hasYMapEntry(note)).toBe(true);
		}
	});

	test("registering the paths first does not decide what happens to the bodies", async () => {
		// Same run, stated the way the bug was: ensureFileMetadata writes an
		// entry for every note before the walk, and the walk must still seed.
		await harness.fill();

		expect(harness.syncStore.hasYMapEntry("one.md")).toBe(true);
		expect(harness.record.seeded).toContain("one.md");
	});
});

describe("a fill that runs twice", () => {
	test("the second pass reuses the files the first pass built", async () => {
		const harness = await makeVault(notes);

		await harness.fill();
		const seededOnce = [...harness.record.seeded];

		await harness.fill();

		// Nothing new: the documents are in memory now, so the walk finds
		// them and does not build a second one for the same path.
		expect(harness.record.seeded).toEqual(seededOnce);
		expect(harness.record.attached).toEqual([]);
		expect(harness.record.adopted).toEqual([]);
	});
});

describe("a path another client is uploading", () => {
	test("is adopted rather than uploaded twice", async () => {
		const harness = await makeVault(notes);
		Object.assign(harness.folder, {
			claimUploadPaths: async () => ({
				won: ["one.md"],
				lost: ["Projects/two.md", "Projects/deep/three.md"],
			}),
		});

		await harness.fill();

		expect(harness.record.seeded).toEqual(["one.md"]);
		expect(harness.record.adopted.sort()).toEqual(
			["Projects/deep/three.md", "Projects/two.md"].sort(),
		);
	});
});

/**
 * #27, the other half: a vault share is persisted with path "", and
 * `SharedFolders._load` looked it up with `getFolderByPath("")` and dropped
 * the share when that came back null. Everywhere else in SharedFolder the
 * root is resolved with `getRoot()` instead, and says why. This is that same
 * exception, in the one place that did not have it.
 */
describe("loading a persisted vault share", () => {
	function makeLoader(getFolderByPath: (path: string) => TFolder | null) {
		const root = new TFolder("/");
		const built: SharedFolderSettings[] = [];
		const folders = Object.create(SharedFolders.prototype) as SharedFolders;
		const noop = () => undefined;
		Object.assign(folders, {
			vault: {
				getRoot: () => root,
				getFolderByPath,
			},
			debug: noop,
			log: noop,
			warn: noop,
			error: noop,
			notifyListeners: noop,
			_new: (
				path: string,
				guid: string,
				relayId?: string,
				_awaiting?: boolean,
				scope?: string,
			) => {
				built.push({ path, guid, relay: relayId, scope: scope as never });
				return {};
			},
		});
		return {
			built,
			load: (settings: SharedFolderSettings[]) =>
				(
					folders as unknown as {
						_load: (s: SharedFolderSettings[]) => void;
					}
				)._load(settings),
		};
	}

	test("survives a restart even though its path is empty", () => {
		// The lookup answers null for "", which is the case this has to
		// survive. What real Obsidian answers for getFolderByPath("") is not
		// something this repo can prove, so the vault share must not depend
		// on it either way.
		const loader = makeLoader(() => null);

		loader.load([
			{ guid: "vault-guid", path: "", scope: "vault", relay: "relay-onprem" },
		]);

		expect(loader.built).toHaveLength(1);
		expect(loader.built[0].guid).toBe("vault-guid");
		expect(loader.built[0].scope).toBe("vault");
	});

	test("a folder share whose folder is gone is still skipped", () => {
		const loader = makeLoader(() => null);

		loader.load([{ guid: "folder-guid", path: "Notes", scope: "folder" }]);

		expect(loader.built).toEqual([]);
	});

	test("a folder share whose folder exists is still loaded", () => {
		const loader = makeLoader((path) => new TFolder(path));

		loader.load([{ guid: "folder-guid", path: "Notes", scope: "folder" }]);

		expect(loader.built).toHaveLength(1);
		expect(loader.built[0].path).toBe("Notes");
	});
});
