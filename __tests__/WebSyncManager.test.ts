/**
 * Unit tests: WebSyncManager auto-sync folder binary filter (TR-31, #34d8835f)
 * and folder-share rate-limited-edit debounce retry (TR-23, #37e7b1e4).
 *
 * TR-31: onFileModified() didn't check the modified file's extension before
 * handing it to syncFolderFile(), which does vault.read(file) (a text read)
 * unconditionally and POSTs the result as JSON {content} to
 * /v1/web/shares/{slug}/files. For a binary file (e.g. .png) this reads
 * corrupted UTF-8 and POSTs garbage — wasted traffic and junk records, with
 * no benefit since folder shares only ever index md/canvas files anyway
 * (see getFolderItems()).
 *
 * TR-23: when a second edit to a folder-share file lands inside the 5s
 * rate-limit window, onFileModified() scheduled a retry via
 * debouncedSyncMap.get(folderPath) → syncFile(folderPath). syncFile() does
 * vault.getAbstractFileByPath(folderPath), gets a TFolder (not a TFile), and
 * silently no-ops — the rate-limited edit never syncs at all.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { TFile, Vault, noticeMock } from "obsidian";
import { WebSyncManager } from "../src/WebSyncManager";
import type { RelayOnPremShareClientManager } from "../src/RelayOnPremShareClientManager";

function makeVault(fileContents: Record<string, string> = {}): Vault {
	const files = new Map<string, TFile>();
	return {
		read: jest.fn(async (file: TFile) => fileContents[file.path] ?? ""),
		getAbstractFileByPath: jest.fn((path: string) => {
			if (!(path in fileContents)) return null;
			let file = files.get(path);
			if (!file) {
				file = new TFile(path);
				files.set(path, file);
			}
			return file;
		}),
	} as unknown as Vault;
}

function makeClientManager(): RelayOnPremShareClientManager {
	return {
		syncFolderFileContent: jest.fn(async () => undefined),
		getClient: jest.fn(),
	} as unknown as RelayOnPremShareClientManager;
}

/** Doc-share sync (syncFile()) goes through clientManager.getClient(serverId).{getShare,updateShare}. */
function makeDocClient(webSlug = "doc-slug") {
	return {
		getShare: jest.fn(async () => ({ web_slug: webSlug })),
		updateShare: jest.fn(async () => undefined),
	};
}

function makeClientManagerWithClient(
	client: ReturnType<typeof makeDocClient>,
): RelayOnPremShareClientManager {
	return {
		syncFolderFileContent: jest.fn(async () => undefined),
		getClient: jest.fn(() => client),
	} as unknown as RelayOnPremShareClientManager;
}

function registerFolderShare(manager: WebSyncManager, folderPath: string): void {
	// Bypass registerAutoSyncShare() (it calls the real obsidian `debounce`,
	// unmocked in this repo's obsidian test double) and populate the private
	// map directly — onFileModified() is the code under test either way.
	(manager as unknown as { autoSyncShares: Map<string, unknown> }).autoSyncShares.set(
		folderPath,
		{ shareId: "s1", serverId: "srv1", lastSync: 0, kind: "folder", webSlug: "my-slug" },
	);
}

describe("WebSyncManager.onFileModified — auto-sync folder binary filter", () => {
	test("skips a binary (.png) file — no read, no POST", async () => {
		const vault = makeVault();
		const clientManager = makeClientManager();
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		await manager.onFileModified(new TFile("notes/image.png"));

		expect(vault.read).not.toHaveBeenCalled();
		expect(clientManager.syncFolderFileContent).not.toHaveBeenCalled();
	});

	test("skips other non-text extensions (.pdf)", async () => {
		const vault = makeVault();
		const clientManager = makeClientManager();
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		await manager.onFileModified(new TFile("notes/handout.pdf"));

		expect(vault.read).not.toHaveBeenCalled();
		expect(clientManager.syncFolderFileContent).not.toHaveBeenCalled();
	});

	test("still syncs a .md file (no regression)", async () => {
		const vault = makeVault({ "notes/note.md": "hello world" });
		const clientManager = makeClientManager();
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		await manager.onFileModified(new TFile("notes/note.md"));

		expect(vault.read).toHaveBeenCalled();
		expect(clientManager.syncFolderFileContent).toHaveBeenCalledWith(
			"srv1",
			"my-slug",
			"note.md",
			"hello world",
		);
	});

	test("still syncs a .canvas file (no regression)", async () => {
		const vault = makeVault({ "notes/board.canvas": "{}" });
		const clientManager = makeClientManager();
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		await manager.onFileModified(new TFile("notes/board.canvas"));

		expect(clientManager.syncFolderFileContent).toHaveBeenCalledWith(
			"srv1",
			"my-slug",
			"board.canvas",
			"{}",
		);
	});

	test("a binary file outside any registered auto-sync folder is a no-op (not our concern)", async () => {
		const vault = makeVault();
		const clientManager = makeClientManager();
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		await manager.onFileModified(new TFile("other-folder/image.png"));

		expect(vault.read).not.toHaveBeenCalled();
		expect(clientManager.syncFolderFileContent).not.toHaveBeenCalled();
	});
});

describe("WebSyncManager.onFileModified — folder-share rate-limited edit retry (TR-23, #37e7b1e4)", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("a rate-limited second edit is not lost — it resyncs the FILE (not the folder) after the debounce window", async () => {
		const vault = makeVault({ "notes/note.md": "second edit content" });
		const clientManager = makeClientManager();
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		// First edit: lastSync starts at 0, so this is not rate-limited — syncs immediately.
		await manager.onFileModified(new TFile("notes/note.md"));
		expect(clientManager.syncFolderFileContent).toHaveBeenCalledTimes(1);
		(clientManager.syncFolderFileContent as jest.Mock).mockClear();
		(vault.getAbstractFileByPath as jest.Mock).mockClear();

		// Second edit arrives inside the 5s rate-limit window — must be scheduled, not synced yet.
		await manager.onFileModified(new TFile("notes/note.md"));
		expect(clientManager.syncFolderFileContent).not.toHaveBeenCalled();

		// Advance past the 2s debounce window — the retry must fire and resolve
		// the FILE at that path (pre-fix: it resolved the FOLDER path via the
		// shared debouncedSyncMap and syncFile() silently dropped it as "not a TFile").
		await jest.advanceTimersByTimeAsync(2100);

		expect(vault.getAbstractFileByPath).toHaveBeenCalledWith("notes/note.md");
		expect(vault.getAbstractFileByPath).not.toHaveBeenCalledWith("notes");
		expect(clientManager.syncFolderFileContent).toHaveBeenCalledWith(
			"srv1",
			"my-slug",
			"note.md",
			"second edit content",
		);
	});

	test("resyncs the LATEST content if the file changes again before the debounce fires", async () => {
		const vault = makeVault({ "notes/note.md": "v1" });
		const clientManager = makeClientManager();
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		await manager.onFileModified(new TFile("notes/note.md")); // immediate sync, not rate limited
		(clientManager.syncFolderFileContent as jest.Mock).mockClear();

		await manager.onFileModified(new TFile("notes/note.md")); // rate limited, scheduled
		await jest.advanceTimersByTimeAsync(500);
		(vault.read as jest.Mock).mockImplementation(async () => "v2"); // vault content changed before debounce fired
		await manager.onFileModified(new TFile("notes/note.md")); // resets the trailing debounce timer

		await jest.advanceTimersByTimeAsync(2100);

		expect(clientManager.syncFolderFileContent).toHaveBeenCalledTimes(1);
		expect(clientManager.syncFolderFileContent).toHaveBeenCalledWith(
			"srv1",
			"my-slug",
			"note.md",
			"v2",
		);
	});

	test("two different rate-limited files in the same folder both resync independently", async () => {
		const vault = makeVault({ "notes/a.md": "content-a", "notes/b.md": "content-b" });
		const clientManager = makeClientManager();
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		await manager.onFileModified(new TFile("notes/a.md")); // immediate sync
		(clientManager.syncFolderFileContent as jest.Mock).mockClear();

		// Both rate limited within the same window.
		await manager.onFileModified(new TFile("notes/a.md"));
		await manager.onFileModified(new TFile("notes/b.md"));
		expect(clientManager.syncFolderFileContent).not.toHaveBeenCalled();

		await jest.advanceTimersByTimeAsync(2100);

		expect(clientManager.syncFolderFileContent).toHaveBeenCalledWith(
			"srv1",
			"my-slug",
			"a.md",
			"content-a",
		);
		expect(clientManager.syncFolderFileContent).toHaveBeenCalledWith(
			"srv1",
			"my-slug",
			"b.md",
			"content-b",
		);
		expect(clientManager.syncFolderFileContent).toHaveBeenCalledTimes(2);
	});

	test("a file deleted before the debounce fires does not throw or sync", async () => {
		const vault = makeVault({ "notes/note.md": "content" });
		const clientManager = makeClientManager();
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		await manager.onFileModified(new TFile("notes/note.md")); // immediate sync
		(clientManager.syncFolderFileContent as jest.Mock).mockClear();

		await manager.onFileModified(new TFile("notes/note.md")); // rate limited, scheduled
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null); // file removed from vault

		await jest.advanceTimersByTimeAsync(2100);

		expect(clientManager.syncFolderFileContent).not.toHaveBeenCalled();
	});
});

describe("WebSyncManager — doc share rename/delete (TR-24, #5aef2c1d)", () => {
	// doc shares are keyed by the file's own path, and onFileModified() reads
	// a debounce closed over that path — real obsidian debounce() is needed
	// here (not the map-bypass registerFolderShare() helper) so a rename
	// actually exercises the re-keyed debounce, not a stub.
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
		noticeMock.mockClear();
	});

	test("a renamed doc share keeps syncing under its new path", async () => {
		const vault = makeVault({ "notes/new-name.md": "renamed content" });
		const client = makeDocClient();
		const clientManager = makeClientManagerWithClient(client);
		const manager = new WebSyncManager(vault, clientManager);

		manager.registerAutoSyncShare("notes/old-name.md", "share1", "srv1", "doc");

		await manager.onFileRenamed("notes/new-name.md", "notes/old-name.md");

		// Registration follows the file — old key gone, new key present.
		expect(manager.isAutoSync("notes/old-name.md")).toBe(false);
		expect(manager.isAutoSync("notes/new-name.md")).toBe(true);

		// This is the actual regression: pre-fix, the registration stayed
		// keyed to the old path, onFileModified()'s lookup by the new path
		// missed, and this edit would vanish silently — no error, no Notice.
		// Doc-share syncs always go through the debounce (unlike folder
		// shares, which sync immediately when not rate limited), so the
		// debounce window has to elapse before it fires.
		await manager.onFileModified(new TFile("notes/new-name.md"));
		await jest.advanceTimersByTimeAsync(2100);

		expect(client.updateShare).toHaveBeenCalledWith("share1", {
			web_content: "renamed content",
		});
	});

	test("a debounce scheduled just before rename fires harmlessly afterward (no stale sync, no crash)", async () => {
		const vault = makeVault({
			"notes/old-name.md": "v1",
			"notes/new-name.md": "v2",
		});
		const client = makeDocClient();
		const clientManager = makeClientManagerWithClient(client);
		const manager = new WebSyncManager(vault, clientManager);

		manager.registerAutoSyncShare("notes/old-name.md", "share1", "srv1", "doc");

		// Edit lands and schedules the (not-yet-fired) debounce under the old key.
		await manager.onFileModified(new TFile("notes/old-name.md"));

		// Rename arrives before that debounce fires — re-keys the registration
		// and creates a fresh debounce bound to the new path. The debounce
		// scheduled above is still ticking (deleting a map entry doesn't
		// cancel its pending timer) and will fire independently, still bound
		// to syncFile(oldPath) via its closure.
		await manager.onFileRenamed("notes/new-name.md", "notes/old-name.md");

		await jest.advanceTimersByTimeAsync(2100);

		// syncFile(oldPath) resolves to a share-info lookup miss (the old key
		// is gone) and no-ops — it must not sync under the stale old path.
		expect(client.updateShare).not.toHaveBeenCalledWith("share1", {
			web_content: "v1",
		});
	});

	test("a deleted doc share is unregistered and the user is notified", async () => {
		const vault = makeVault({ "notes/note.md": "content" });
		const clientManager = makeClientManagerWithClient(makeDocClient());
		const manager = new WebSyncManager(vault, clientManager);

		manager.registerAutoSyncShare("notes/note.md", "share1", "srv1", "doc");
		expect(manager.isAutoSync("notes/note.md")).toBe(true);

		await manager.onFileDeleted("notes/note.md");

		expect(manager.isAutoSync("notes/note.md")).toBe(false);
		expect(noticeMock).toHaveBeenCalledWith(
			expect.stringContaining("notes/note.md"),
			0,
		);

		// Confirms unregistration is real, not just isAutoSync() lying: a
		// later edit at the same path (e.g. a new unrelated file created at
		// the identical vault path) must not silently piggyback on the old
		// share's sync state.
		await manager.onFileModified(new TFile("notes/note.md"));
		expect(clientManager.getClient).not.toHaveBeenCalled();
	});

	test("deleting a file that is not a registered doc share is a no-op (no Notice)", async () => {
		const vault = makeVault({ "notes/note.md": "content" });
		const clientManager = makeClientManagerWithClient(makeDocClient());
		const manager = new WebSyncManager(vault, clientManager);

		await manager.onFileDeleted("notes/unrelated.md");

		expect(noticeMock).not.toHaveBeenCalled();
	});
});

/** Resolves/rejects on demand — lets a test observe state while the mocked call is still pending. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("WebSyncManager — isOutboundSyncing echo-guard (TR-25, #652db7ce)", () => {
	// The flag was declared and read by InboundSyncPoller/InboundFileDownloader
	// but never written anywhere — grep confirmed 3 reads, 0 writes. These
	// tests observe it mid-flight (the network call deferred, not yet
	// resolved) since a naive "await the whole sync" leaves no window to see
	// it ever having been true.
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("is true while a folder-share sync is in flight, false once it settles", async () => {
		const vault = makeVault({ "notes/note.md": "content" });
		const clientManager = makeClientManager();
		const pending = deferred<void>();
		(clientManager.syncFolderFileContent as jest.Mock).mockReturnValue(pending.promise);
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		const modifyPromise = manager.onFileModified(new TFile("notes/note.md"));

		// Flush microtasks up to (but not past) the pending network call.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(manager.isOutboundSyncing).toBe(true);

		pending.resolve();
		await modifyPromise;

		expect(manager.isOutboundSyncing).toBe(false);
	});

	test("is true while a doc-share sync is in flight, false once it settles", async () => {
		const vault = makeVault({ "notes/note.md": "content" });
		const client = makeDocClient();
		const pending = deferred<void>();
		(client.updateShare as jest.Mock).mockReturnValue(pending.promise);
		const clientManager = makeClientManagerWithClient(client);
		const manager = new WebSyncManager(vault, clientManager);
		manager.registerAutoSyncShare("notes/note.md", "share1", "srv1", "doc");

		void manager.onFileModified(new TFile("notes/note.md"));
		// Doc-share syncs always go through the debounce — fire it.
		await jest.advanceTimersByTimeAsync(2100);

		expect(manager.isOutboundSyncing).toBe(true);

		pending.resolve();
		await jest.advanceTimersByTimeAsync(0);

		expect(manager.isOutboundSyncing).toBe(false);
	});

	test("stays true while ONE of two concurrent outbound syncs is still in flight (ref-counted, not a plain flag)", async () => {
		const vault = makeVault({ "notes/a.md": "a", "notes/b.md": "b" });
		const clientManager = makeClientManager();
		const pendingA = deferred<void>();
		const pendingB = deferred<void>();
		(clientManager.syncFolderFileContent as jest.Mock)
			.mockReturnValueOnce(pendingA.promise)
			.mockReturnValueOnce(pendingB.promise);
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		const syncA = manager.onFileModified(new TFile("notes/a.md"));
		const syncB = manager.onFileModified(new TFile("notes/b.md"));

		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(manager.isOutboundSyncing).toBe(true);

		// A finishes; B is still in flight. A naive boolean flag would clear
		// here and let InboundSyncPoller/InboundFileDownloader run right
		// through B's still-uploading content — the actual echo-loop risk
		// this task exists to close.
		pendingA.resolve();
		await syncA;
		expect(manager.isOutboundSyncing).toBe(true);

		pendingB.resolve();
		await syncB;
		expect(manager.isOutboundSyncing).toBe(false);
	});

	test("resets to false even when the outbound sync throws", async () => {
		const vault = makeVault({ "notes/note.md": "content" });
		const clientManager = makeClientManager();
		(clientManager.syncFolderFileContent as jest.Mock).mockRejectedValue(new Error("network error"));
		const manager = new WebSyncManager(vault, clientManager);
		registerFolderShare(manager, "notes");

		await manager.onFileModified(new TFile("notes/note.md"));

		expect(manager.isOutboundSyncing).toBe(false);
	});
});
