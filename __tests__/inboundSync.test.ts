/**
 * Unit tests: InboundSyncPoller + InboundFileDownloader
 *
 * Covers:
 *   (a) poller fires on web_content_updated_at bump; skips when unchanged
 *   (b) downloader diffs file index by sha256 and writes only new/changed items
 *   (c) no outbound echo triggered during inbound write (writingPaths guard)
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

// ─── Import from obsidian (moduleNameMapper → __tests__/mocks/obsidian.ts) ────
import { TFile, noticeMock } from "obsidian";

// ─── Mock hashing so tests don't need WebCrypto ───────────────────────────────
const mockGenerateHash = jest.fn<() => Promise<string>>();
jest.mock("src/hashing", () => ({
	generateHash: mockGenerateHash,
}));

// ─── Mock debug logging (no-op) ───────────────────────────────────────────────
jest.mock("src/debug", () => ({
	curryLog: () => () => undefined,
}));

import { MockTimeProvider } from "./mocks/MockTimeProvider";
import { InboundSyncPoller } from "src/InboundSyncPoller";
import { InboundFileDownloader } from "src/InboundFileDownloader";
import type { RelayOnPremShareClientManager } from "src/RelayOnPremShareClientManager";
import type { WebSyncManager } from "src/WebSyncManager";
import type { Vault } from "obsidian";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Flush all pending microtasks (resolves mock promises queued by mockResolvedValue). */
const flushPromises = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

const SHARE_ID = "share-001";
const SERVER_ID = "server-001";
const SHARE_PATH = "shared/docs";

function makeShare(webContentUpdatedAt: string | null = null) {
	return {
		id: SHARE_ID,
		kind: "folder" as const,
		path: SHARE_PATH,
		visibility: "private" as const,
		owner_user_id: "user-1",
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		web_content_updated_at: webContentUpdatedAt,
	};
}

function makeMockClientManager(overrides: Partial<{
	getShare: jest.Mock;
	getFilesIndex: jest.Mock;
	downloadFile: jest.Mock;
}> = {}): jest.Mocked<Pick<RelayOnPremShareClientManager, "getShare" | "getFilesIndex" | "downloadFile">> {
	return {
		getShare: jest.fn<RelayOnPremShareClientManager["getShare"]>().mockResolvedValue(makeShare() as any),
		getFilesIndex: jest.fn<RelayOnPremShareClientManager["getFilesIndex"]>().mockResolvedValue([]),
		downloadFile: jest.fn<RelayOnPremShareClientManager["downloadFile"]>().mockResolvedValue(new ArrayBuffer(4)),
		...overrides,
	} as any;
}

function makeMockWebSyncManager(isOutboundSyncing = false): Pick<WebSyncManager, "isOutboundSyncing"> {
	return { isOutboundSyncing };
}

function makeMockVault() {
	const adapter = {
		mkdir: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
		writeBinary: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
	};
	return {
		getAbstractFileByPath: jest.fn<(path: string) => TFile | null>().mockReturnValue(null),
		readBinary: jest.fn<() => Promise<ArrayBuffer>>().mockResolvedValue(new ArrayBuffer(4)),
		adapter,
	} as unknown as Vault & { adapter: typeof adapter; getAbstractFileByPath: jest.Mock; readBinary: jest.Mock };
}

// ─── InboundSyncPoller ────────────────────────────────────────────────────────

describe("InboundSyncPoller", () => {
	let timeProvider: MockTimeProvider;
	let clientManager: ReturnType<typeof makeMockClientManager>;
	let webSyncManager: ReturnType<typeof makeMockWebSyncManager>;
	let fileDownloader: jest.Mocked<Pick<InboundFileDownloader, "downloadShare" | "isInboundWriting">>;
	let poller: InboundSyncPoller;
	let startTime: number;

	beforeEach(() => {
		jest.clearAllMocks();
		timeProvider = new MockTimeProvider();
		startTime = timeProvider.getTime();
		clientManager = makeMockClientManager();
		webSyncManager = makeMockWebSyncManager();
		fileDownloader = {
			downloadShare: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
			isInboundWriting: jest.fn<() => boolean>().mockReturnValue(false),
		};
		poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			fileDownloader as any,
			30_000,
		);
	});

	test("fires downloadShare when web_content_updated_at bumps", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(clientManager.getShare).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, true);
		expect(fileDownloader.downloadShare).toHaveBeenCalledWith(SHARE_ID, SERVER_ID);
	});

	test("skips downloadShare when web_content_updated_at is unchanged", async () => {
		const ts = "2026-06-08T10:00:00Z";
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare(ts));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		// First tick — bumps from null → ts → should download
		timeProvider.setTime(startTime + 30_000);
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);

		// Second tick — same ts → should skip
		timeProvider.setTime(startTime + 60_000);
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);
	});

	test("skips polling entirely when isOutboundSyncing is true", async () => {
		(webSyncManager as any).isOutboundSyncing = true;
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(clientManager.getShare).not.toHaveBeenCalled();
		expect(fileDownloader.downloadShare).not.toHaveBeenCalled();
	});

	test("does not fire when web_content_updated_at is null", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare(null));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(fileDownloader.downloadShare).not.toHaveBeenCalled();
	});

	test("handles getShare errors without crashing the poller", async () => {
		(clientManager.getShare as jest.Mock).mockRejectedValue(new Error("Network error"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await expect(flushPromises()).resolves.toBeUndefined();

		// Poller remains alive for next tick
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));
		timeProvider.setTime(startTime + 60_000);
		await flushPromises();
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);
	});

	test("unregisterShare stops polling for that share", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();
		poller.unregisterShare(SHARE_ID);

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(clientManager.getShare).not.toHaveBeenCalled();
		expect(fileDownloader.downloadShare).not.toHaveBeenCalled();
	});

	test("start is idempotent (second call does not double-register interval)", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();
		poller.start(); // second call should be a no-op

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		// downloadShare should fire exactly once, not twice
		expect(fileDownloader.downloadShare).toHaveBeenCalledTimes(1);
	});

	test("destroy clears interval so no further polls occur", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();
		poller.destroy();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(clientManager.getShare).not.toHaveBeenCalled();
		expect(fileDownloader.downloadShare).not.toHaveBeenCalled();
	});
});

// ─── InboundFileDownloader ────────────────────────────────────────────────────

describe("InboundFileDownloader", () => {
	let clientManager: ReturnType<typeof makeMockClientManager>;
	let webSyncManager: { isOutboundSyncing: boolean };
	let vault: ReturnType<typeof makeMockVault>;
	let downloader: InboundFileDownloader;

	beforeEach(() => {
		jest.clearAllMocks();
		mockGenerateHash.mockResolvedValue("hash-aabbcc");
		clientManager = makeMockClientManager();
		webSyncManager = { isOutboundSyncing: false };
		vault = makeMockVault();
		downloader = new InboundFileDownloader(vault, clientManager as any, webSyncManager as any);
	});

	test("skips download when outbound sync is in flight", async () => {
		webSyncManager.isOutboundSyncing = true;
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "abc", size: 10, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		expect(clientManager.getFilesIndex).not.toHaveBeenCalled();
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("downloads and writes new sync-artifact items to vault", async () => {
		const content = new ArrayBuffer(8);
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(content);
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		expect(clientManager.downloadFile).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "note.md");
		expect(vault.adapter.writeBinary).toHaveBeenCalledWith(
			`${SHARE_PATH}/note.md`,
			content,
		);
	});

	test("skips items whose sha256 is unchanged since last download", async () => {
		const content = new ArrayBuffer(8);
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(content);
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

		// First download — writes the file
		await downloader.downloadShare(SHARE_ID, SERVER_ID);
		expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1);

		jest.clearAllMocks();

		// Second download — same sha256, must skip
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);

		await downloader.downloadShare(SHARE_ID, SERVER_ID);
		expect(clientManager.downloadFile).not.toHaveBeenCalled();
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("downloads and writes when sha256 changes (updated item)", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

		// First: sha-001
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		jest.clearAllMocks();

		// Second: sha-002 (updated)
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-002", size: 12, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
		]);
		const newContent = new ArrayBuffer(12);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(newContent);
		// File now exists in vault
		const existingFile = new TFile(`${SHARE_PATH}/note.md`);
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(existingFile);
		// Local hash matches what we last wrote (sha-001), so not user-edited
		mockGenerateHash.mockResolvedValue("sha-001");

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		expect(clientManager.downloadFile).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "note.md");
		expect(vault.adapter.writeBinary).toHaveBeenCalledWith(`${SHARE_PATH}/note.md`, newContent);
	});

	test("skips user-edited files (local hash differs from last-written hash)", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

		// First download establishes last written hash = sha-001
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		jest.clearAllMocks();

		// Second download: server has sha-002, file exists, local hash = user-edited-hash (≠ sha-001)
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-002", size: 12, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
		]);
		const existingFile = new TFile(`${SHARE_PATH}/note.md`);
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(existingFile);
		// User edited the file — local hash differs from what we last wrote
		mockGenerateHash.mockResolvedValue("user-edited-hash");

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		expect(clientManager.downloadFile).not.toHaveBeenCalled();
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("filters out non-sync-artifact items from the index", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "web-doc.md", sha256: "sha-doc", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "web-doc" },
			{ path: "artifact.md", sha256: "sha-art", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			{ path: "no-type.md", sha256: "sha-none", size: 4, updated_at: "2026-01-01T00:00:00Z" }, // no type = treated as sync-artifact
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		// Only artifact.md and no-type.md should be downloaded (not web-doc.md)
		expect(clientManager.downloadFile).toHaveBeenCalledTimes(2);
		expect(clientManager.downloadFile).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "artifact.md");
		expect(clientManager.downloadFile).toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "no-type.md");
		expect(clientManager.downloadFile).not.toHaveBeenCalledWith(SERVER_ID, SHARE_ID, "web-doc.md");
	});

	test("does nothing when files index is empty", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([]);

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("handles share path resolution failure gracefully", async () => {
		(clientManager.getShare as jest.Mock).mockRejectedValue(new Error("Not found"));

		await expect(downloader.downloadShare(SHARE_ID, SERVER_ID)).resolves.toBe("ran");
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("handles files index fetch failure gracefully", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockRejectedValue(new Error("Server error"));

		await expect(downloader.downloadShare(SHARE_ID, SERVER_ID)).resolves.toBe("ran");
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("handles download failure for individual file gracefully (other files still written)", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "fail.md", sha256: "sha-fail", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			{ path: "ok.md", sha256: "sha-ok", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
		(clientManager.downloadFile as jest.Mock)
			.mockRejectedValueOnce(new Error("Download failed"))
			.mockResolvedValueOnce(new ArrayBuffer(4));

		await expect(downloader.downloadShare(SHARE_ID, SERVER_ID)).resolves.toBe("ran");
		expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
		expect(vault.adapter.writeBinary).toHaveBeenCalledWith(`${SHARE_PATH}/ok.md`, expect.any(ArrayBuffer));
	});

	describe("echo-loop guard (isInboundWriting)", () => {
		test("isInboundWriting returns true during vault write, false after", async () => {
			const vaultPath = `${SHARE_PATH}/note.md`;
			let writingDuringWrite = false;

			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

			vault.adapter.writeBinary = jest.fn().mockImplementation(async (path: string) => {
				writingDuringWrite = downloader.isInboundWriting(path);
			}) as any;

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(writingDuringWrite).toBe(true);
			expect(downloader.isInboundWriting(vaultPath)).toBe(false);
		});

		test("isInboundWriting returns false when no write is in progress", () => {
			expect(downloader.isInboundWriting("any/path.md")).toBe(false);
		});

		test("writingPaths is cleared even when writeBinary throws", async () => {
			const vaultPath = `${SHARE_PATH}/error.md`;

			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "error.md", sha256: "sha-err", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
			vault.adapter.writeBinary = jest.fn().mockRejectedValue(new Error("Disk full")) as any;

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			// Guard must be cleared in finally block
			expect(downloader.isInboundWriting(vaultPath)).toBe(false);
		});
	});

	test("skips file when readBinary throws (avoid data loss)", async () => {
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

		// First download: write file, establishing lastHash = "sha-001"
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
		]);
		(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		jest.clearAllMocks();

		// Second download: new sha-002, file exists, readBinary throws
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
		(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
			{ path: "note.md", sha256: "sha-002", size: 8, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
		]);
		const existingFile = new TFile(`${SHARE_PATH}/note.md`);
		(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(existingFile);
		(vault.readBinary as jest.Mock).mockRejectedValue(new Error("IO error"));

		await downloader.downloadShare(SHARE_ID, SERVER_ID);

		// Should skip rather than risk overwriting the file
		expect(clientManager.downloadFile).not.toHaveBeenCalled();
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("destroy clears internal state", () => {
		downloader.destroy();
		// After destroy, no in-flight paths remain
		expect(downloader.isInboundWriting("any/path.md")).toBe(false);
	});

	describe("path-traversal guard", () => {
		test("rejects relativePath that escapes sharePath (../../etc/passwd)", async () => {
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "../../etc/passwd", sha256: "sha-evil", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
		});

		test("rejects relativePath targeting .obsidian/plugins", async () => {
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "../../.obsidian/plugins/evil.js", sha256: "sha-evil2", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
		});

		test("allows valid relative paths inside sharePath", async () => {
			const content = new ArrayBuffer(4);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "subdir/note.md", sha256: "sha-ok", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(content);
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(vault.adapter.writeBinary).toHaveBeenCalledWith(
				`${SHARE_PATH}/subdir/note.md`,
				content,
			);
		});

		test("rejects traversal but still processes safe files in same batch", async () => {
			const content = new ArrayBuffer(4);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "../../etc/passwd", sha256: "sha-evil", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
				{ path: "safe.md", sha256: "sha-safe", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(content);
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			// Only the safe file should be written
			expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
			expect(vault.adapter.writeBinary).toHaveBeenCalledWith(`${SHARE_PATH}/safe.md`, content);
		});

		test("fails closed when server-supplied sharePath is empty", async () => {
			(clientManager.getShare as jest.Mock).mockResolvedValue({ ...makeShare(), path: "" });
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "../../etc/passwd", sha256: "sha-evil", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
				{ path: "note.md", sha256: "sha-ok", size: 4, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			// An empty sharePath must reject everything, not implicitly allow root-relative paths.
			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
		});
	});

	// ─── TR-02 (#307f52bf): persisted hash manifest survives a "restart" ────────
	describe("persisted hash manifest (TR-02)", () => {
		test("REGRESSION: a user edit is still detected after the manifest is reloaded from a persisted store (simulated restart)", async () => {
			// A plain Map here stands in for LocalStorage — the point under test is
			// that the manifest OUTLIVES the InboundFileDownloader instance, not the
			// specific persistence backend.
			const persistedStore = new Map<string, Record<string, string>>();

			const firstSession = new InboundFileDownloader(
				vault,
				clientManager as any,
				webSyncManager as any,
				persistedStore,
			);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
			await firstSession.downloadShare(SHARE_ID, SERVER_ID);
			expect(persistedStore.get(SHARE_ID)).toEqual({ "note.md": "sha-001" });

			jest.clearAllMocks();
			noticeMock.mockClear();

			// "Restart": brand-new InboundFileDownloader instance (in-memory state
			// gone, exactly like a plugin reload), but wired to the SAME persisted
			// store — this is what main.ts does via LocalStorage across a real restart.
			const secondSession = new InboundFileDownloader(
				vault,
				clientManager as any,
				webSyncManager as any,
				persistedStore,
			);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "note.md", sha256: "sha-002", size: 12, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
			]);
			const existingFile = new TFile(`${SHARE_PATH}/note.md`);
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(existingFile);
			// The user edited the file locally while Obsidian was closed.
			mockGenerateHash.mockResolvedValue("user-edited-hash");

			await secondSession.downloadShare(SHARE_ID, SERVER_ID);

			// The pre-fix bug: a fresh in-memory manifest reads as "no history", the
			// `if (lastHash)` guard never fires, and this call overwrites the user's
			// edit unconditionally. Fixed: the persisted manifest survives the
			// "restart" so the edit is still detected and the file is left alone.
			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
			expect(noticeMock).toHaveBeenCalledTimes(1);
			expect(noticeMock.mock.calls[0][0]).toContain("note.md");
		});

		test("shows a Notice when skipping a user-edited (or unknown-provenance) file", async () => {
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "note.md", sha256: "sha-002", size: 12, updated_at: "2026-01-02T00:00:00Z", type: "sync-artifact" },
			]);
			const existingFile = new TFile(`${SHARE_PATH}/note.md`);
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(existingFile);
			mockGenerateHash.mockResolvedValue("some-other-hash");

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(noticeMock).toHaveBeenCalledTimes(1);
			const [message] = noticeMock.mock.calls[0];
			expect(message).toContain("note.md");
			expect(message.toLowerCase()).toContain("skipped");
		});

		test("REGRESSION: a local file with NO recorded history is no longer silently overwritten if it differs from the server", async () => {
			// Fresh manifest (no prior download at all — not just a restart), and a
			// local file that already exists with content the downloader has never
			// seen. The old `if (lastHash)` guard skipped the whole safety check in
			// this case and downloaded straight over it.
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "preexisting.md", sha256: "sha-server", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			const existingFile = new TFile(`${SHARE_PATH}/preexisting.md`);
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(existingFile);
			mockGenerateHash.mockResolvedValue("hash-of-unrelated-local-content");

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(clientManager.downloadFile).not.toHaveBeenCalled();
			expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
			expect(noticeMock).toHaveBeenCalledTimes(1);
		});

		test("a local file with no history that ALREADY matches the server content is accepted (no false-positive skip)", async () => {
			const content = new ArrayBuffer(4);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "preexisting.md", sha256: "sha-server", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			const existingFile = new TFile(`${SHARE_PATH}/preexisting.md`);
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(existingFile);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(content);
			// Local content happens to already match what the server has.
			mockGenerateHash.mockResolvedValue("sha-server");

			await downloader.downloadShare(SHARE_ID, SERVER_ID);

			expect(noticeMock).not.toHaveBeenCalled();
		});

		test("destroy() does NOT clear an injected (persisted) hash manifest", async () => {
			const persistedStore = new Map<string, Record<string, string>>();
			const persistentDownloader = new InboundFileDownloader(
				vault,
				clientManager as any,
				webSyncManager as any,
				persistedStore,
			);
			(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare());
			(clientManager.getFilesIndex as jest.Mock).mockResolvedValue([
				{ path: "note.md", sha256: "sha-001", size: 8, updated_at: "2026-01-01T00:00:00Z", type: "sync-artifact" },
			]);
			(clientManager.downloadFile as jest.Mock).mockResolvedValue(new ArrayBuffer(4));
			(vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
			await persistentDownloader.downloadShare(SHARE_ID, SERVER_ID);
			expect(persistedStore.size).toBe(1);

			persistentDownloader.destroy();

			// The whole point of injecting a persisted store is that plugin
			// unload/reload does not wipe it — only in-memory-only state does.
			expect(persistedStore.size).toBe(1);
			expect(persistedStore.get(SHARE_ID)).toEqual({ "note.md": "sha-001" });
		});
	});
});

// ─── TR-02 (#307f52bf): persisted lastUpdatedAt survives a "restart" ──────────
describe("InboundSyncPoller persisted lastUpdatedAt (TR-02)", () => {
	let timeProvider: MockTimeProvider;
	let clientManager: ReturnType<typeof makeMockClientManager>;
	let webSyncManager: ReturnType<typeof makeMockWebSyncManager>;
	let fileDownloader: jest.Mocked<Pick<InboundFileDownloader, "downloadShare" | "isInboundWriting">>;
	let startTime: number;

	beforeEach(() => {
		jest.clearAllMocks();
		timeProvider = new MockTimeProvider();
		startTime = timeProvider.getTime();
		clientManager = makeMockClientManager();
		webSyncManager = makeMockWebSyncManager();
		fileDownloader = {
			downloadShare: jest.fn<() => Promise<"ran" | "skipped">>().mockResolvedValue("ran"),
			isInboundWriting: jest.fn<() => boolean>().mockReturnValue(false),
		};
	});

	test("REGRESSION: registerShare seeds lastUpdatedAt from the persisted store instead of always null, so an unchanged share does not re-download on restart", async () => {
		const ts = "2026-06-08T10:00:00Z";
		const persistedStore = new Map<string, string>([[SHARE_ID, ts]]);
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			fileDownloader as any,
			30_000,
			persistedStore,
		);
		// Server content is unchanged since the persisted watermark.
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare(ts));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		// Pre-fix bug: registerShare always started at lastUpdatedAt=null, so this
		// first poll would read as "bumped" and trigger a full re-download even
		// though nothing changed server-side. Fixed: seeded from the persisted
		// watermark, so an unchanged share stays skipped.
		expect(fileDownloader.downloadShare).not.toHaveBeenCalled();
	});

	test("a genuinely new share (not in the persisted store) still downloads on first poll", async () => {
		const persistedStore = new Map<string, string>();
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			fileDownloader as any,
			30_000,
			persistedStore,
		);
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(fileDownloader.downloadShare).toHaveBeenCalledWith(SHARE_ID, SERVER_ID);
	});

	test("advancing lastUpdatedAt writes through to the persisted store, not just the in-memory copy", async () => {
		const persistedStore = new Map<string, string>();
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			fileDownloader as any,
			30_000,
			persistedStore,
		);
		const ts = "2026-06-08T10:00:00Z";
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare(ts));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(persistedStore.get(SHARE_ID)).toBe(ts);
	});

	test("a skipped download (outbound sync in flight) does NOT advance the persisted watermark", async () => {
		const persistedStore = new Map<string, string>();
		fileDownloader.downloadShare = jest
			.fn<() => Promise<"ran" | "skipped">>()
			.mockResolvedValue("skipped");
		const poller = new InboundSyncPoller(
			timeProvider,
			clientManager as any,
			webSyncManager as any,
			fileDownloader as any,
			30_000,
			persistedStore,
		);
		(clientManager.getShare as jest.Mock).mockResolvedValue(makeShare("2026-06-08T10:00:00Z"));

		poller.registerShare(SHARE_ID, SERVER_ID);
		poller.start();

		timeProvider.setTime(startTime + 30_000);
		await flushPromises();

		expect(persistedStore.has(SHARE_ID)).toBe(false);
	});
});
