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
import { TFile, Vault } from "obsidian";
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
