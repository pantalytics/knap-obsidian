/**
 * The queue warms the tokens for the work just ahead of it.
 *
 * The batch token route can answer for a hundred documents, but only the few
 * syncs the queue admits were ever waiting on a token, so a batch carried
 * three ids. The queue now asks the token store for the next window's tokens
 * before admitting work; the store dedupes, so this costs nothing on a tick
 * where nothing changed.
 */
import { describe, test, expect, jest } from "@jest/globals";

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
import { ObservableSet } from "src/observable/ObservableSet";
import { S3RN, S3RemoteDocument } from "src/S3RN";

const RELAY = "11111111-1111-4111-8111-111111111111";
const FOLDER = "22222222-2222-4222-8222-222222222222";

function makeSync(paths: string[], connected: boolean) {
	const warm = jest.fn();
	const folder = { connected } as unknown as SharedFolder;
	const noop = () => undefined;
	const sync = Object.create(BackgroundSync.prototype) as BackgroundSync;
	const items: QueueItem[] = paths.map((path, i) => ({
		guid: path,
		path,
		doc: {
			path,
			tokenStore: { warm },
			s3rn: new S3RemoteDocument(
				RELAY,
				FOLDER,
				`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
			),
			getVaultPath: () => path,
		} as unknown as QueueItem["doc"],
		status: "pending",
		sharedFolder: folder,
	}));
	Object.assign(sync, {
		debug: noop,
		log: noop,
		warn: noop,
		error: noop,
		isPaused: false,
		isProcessingSync: false,
		concurrency: 3,
		syncQueue: items,
		downloadQueue: [],
		activeSync: new ObservableSet<unknown>(),
		syncGroups: new Map(),
		inProgressSyncs: new Set<string>(paths),
		syncCompletionCallbacks: new Map(),
		timeProvider: { setTimeout: noop },
		syncDocument: () => Promise.resolve(true),
	});
	return { sync, warm };
}

describe("warming the tokens ahead of the queue", () => {
	test("every queued document is asked for, not just the admitted few", () => {
		const paths = Array.from({ length: 20 }, (_, i) => `note-${i}.md`);
		const { sync, warm } = makeSync(paths, true);

		(sync as unknown as { processSyncQueue: () => void }).processSyncQueue();

		expect(warm).toHaveBeenCalledTimes(20);
		const first = warm.mock.calls[0] as [string, string];
		expect(first[0]).toBe(
			S3RN.encode(
				new S3RemoteDocument(RELAY, FOLDER, "00000000-0000-4000-8000-000000000000"),
			),
		);
		expect(first[1]).toBe("note-0.md");
	});

	test("the window is one batch wide, tokens beyond it wait their turn", () => {
		const paths = Array.from({ length: 250 }, (_, i) => `note-${i}.md`);
		const { sync, warm } = makeSync(paths, true);

		(sync as unknown as { processSyncQueue: () => void }).processSyncQueue();

		expect(warm).toHaveBeenCalledTimes(100);
	});

	test("a disconnected folder's queue warms nothing", () => {
		const { sync, warm } = makeSync(["note.md"], false);

		(sync as unknown as { processSyncQueue: () => void }).processSyncQueue();

		expect(warm).not.toHaveBeenCalled();
	});
});
