/**
 * What a document sync says when it did not write the body (#38).
 *
 * `syncDocumentWebsocket` has four ways out before the one line that copies a
 * note into its Y.Text, and each of them used to leave a document registered
 * on the relay with nothing in it while the queue counted the sync as done.
 * One of the four said nothing at all: a failed read was caught and turned
 * into "", which then matched the empty Y.Text, so the insert was skipped and
 * the sync reported success.
 *
 * These drive the real method against a fake relay and a fake vault, and
 * check the two things that matter: an exit without a body answers false, and
 * a file that will not open is never treated as an empty one.
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import * as Y from "yjs";

jest.mock("src/storage/y-indexeddb", () => ({
	IndexeddbPersistence: class {},
}));
jest.mock("pocketbase", () => ({
	__esModule: true,
	default: class {},
	BaseAuthStore: class {},
}));

import { BackgroundSync, type QueueItem, type SyncGroup } from "src/BackgroundSync";
import { Document } from "src/Document";
import { ObservableMap } from "src/observable/ObservableMap";
import { ObservableSet } from "src/observable/ObservableSet";

/** Let the queue's promise chain run to its end. */
const flush = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

interface VaultBehaviour {
	exists?: boolean;
	read?: () => Promise<string>;
	connect?: boolean;
	/** Never resolves when false, so the sync has to time out. */
	providerSyncs?: boolean;
}

interface Fixture {
	sync: BackgroundSync;
	doc: Document;
	logged: string[];
}

function makeFixture(behaviour: VaultBehaviour = {}): Fixture {
	const {
		exists = true,
		read = () => Promise.resolve("# a note\n\nwith a body in it"),
		connect = true,
		providerSyncs = true,
	} = behaviour;

	const logged: string[] = [];
	const collect =
		(level: string) =>
		(...args: unknown[]) => {
			logged.push(`${level} ${args.map((a) => String(a)).join(" ")}`);
		};

	const ydoc = new Y.Doc();
	const doc = Object.create(Document.prototype) as Document;
	const sharedFolder = {
		relayId: "relay-onprem",
		exists: () => Promise.resolve(exists),
		read,
		tokenStore: { removeFromRefreshQueue: () => undefined },
	};

	Object.assign(doc, {
		path: "one.md",
		guid: "doc-guid",
		ydoc,
		userLock: false,
		_parent: sharedFolder,
		_provider: { intent: "disconnected", awareness: null, ws: null },
		connect: () => Promise.resolve(connect),
		disconnect: () => undefined,
		onceProviderSynced: () =>
			providerSyncs
				? Promise.resolve()
				: new Promise<void>(() => {
						/* never */
					}),
	});
	// s3rn is a setter on HasProvider that goes and refreshes a token.
	Object.defineProperty(doc, "s3rn", { value: { toString: () => "s3rn" } });

	const sync = Object.create(BackgroundSync.prototype) as BackgroundSync;
	Object.assign(sync, {
		debug: collect("debug"),
		log: collect("log"),
		warn: collect("warn"),
		error: collect("error"),
	});

	return { sync, doc, logged };
}

describe("a document whose local file will not open", () => {
	let fixture: Fixture;

	beforeEach(() => {
		fixture = makeFixture({
			exists: true,
			read: () => Promise.reject(new Error("EACCES")),
		});
	});

	test("does not report a successful sync", async () => {
		const result = await fixture.sync.syncDocumentWebsocket(fixture.doc);

		expect(result).toBe(false);
	});

	test("says so, rather than passing the file off as empty", async () => {
		await fixture.sync.syncDocumentWebsocket(fixture.doc);

		expect(fixture.logged.some((line) => line.startsWith("error"))).toBe(true);
		expect(fixture.logged.join("\n")).toContain("one.md");
	});

	test("leaves the document alone instead of connecting and claiming it", async () => {
		const connect = jest.fn(() => Promise.resolve(true));
		Object.assign(fixture.doc, { connect });

		await fixture.sync.syncDocumentWebsocket(fixture.doc);

		expect(connect).not.toHaveBeenCalled();
	});
});

describe("a document with no local file at all", () => {
	test("is not an error, it is a note arriving from the relay", async () => {
		const fixture = makeFixture({
			exists: false,
			read: () => Promise.reject(new Error("ENOENT")),
		});

		const result = await fixture.sync.syncDocumentWebsocket(fixture.doc);

		expect(result).toBe(true);
		expect(fixture.logged.some((line) => line.startsWith("error"))).toBe(false);
	});
});

describe("a document the relay never answers for", () => {
	test("answers false when the connection fails", async () => {
		const fixture = makeFixture({ connect: false });

		const result = await fixture.sync.syncDocumentWebsocket(fixture.doc);

		expect(result).toBe(false);
		expect(fixture.logged.join("\n")).toContain("connect failed");
	});

	test("answers false when the sync times out", async () => {
		jest.useFakeTimers();
		try {
			const fixture = makeFixture({ providerSyncs: false });

			const pending = fixture.sync.syncDocumentWebsocket(fixture.doc);
			// Let the read and the connect settle, then run out the clock.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			jest.advanceTimersByTime(31000);

			expect(await pending).toBe(false);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("a document that syncs cleanly", () => {
	test("writes the body into the empty relay document and reports success", async () => {
		const fixture = makeFixture();

		const result = await fixture.sync.syncDocumentWebsocket(fixture.doc);

		expect(result).toBe(true);
		expect(fixture.doc.ydoc.getText("contents").toJSON()).toBe(
			"# a note\n\nwith a body in it",
		);
	});
});

/**
 * The other half of the same complaint: the queue counted a sync that wrote
 * nothing as one more document done, so a fill that filled nothing still
 * arrived at "up to date".
 */
describe("what the queue makes of a sync that wrote no body", () => {
	function makeQueue(outcome: boolean) {
		const { doc } = makeFixture();
		const sharedFolder = { connected: true } as unknown as never;
		const item: QueueItem = {
			guid: "doc-guid",
			path: "one.md",
			doc,
			status: "pending",
			sharedFolder,
		};
		const group: SyncGroup = {
			sharedFolder,
			total: 1,
			completed: 0,
			status: "running",
			downloads: 0,
			syncs: 1,
			completedDownloads: 0,
			completedSyncs: 0,
		};

		const noop = () => undefined;
		const sync = Object.create(BackgroundSync.prototype) as BackgroundSync;
		const syncGroups = new ObservableMap<unknown, unknown>();
		syncGroups.set(sharedFolder, group);
		Object.assign(sync, {
			debug: noop,
			log: noop,
			warn: noop,
			error: noop,
			isPaused: false,
			isProcessingSync: false,
			concurrency: 3,
			syncQueue: [item],
			activeSync: new ObservableSet<unknown>(),
			syncGroups,
			inProgressSyncs: new Set<string>(["doc-guid"]),
			syncCompletionCallbacks: new Map(),
			timeProvider: { setTimeout: noop },
			syncDocument: () => Promise.resolve(outcome),
		});

		return {
			item,
			group,
			run: () =>
				(sync as unknown as { processSyncQueue: () => void }).processSyncQueue(),
		};
	}

	test("a sync that wrote the body counts as done", async () => {
		const queue = makeQueue(true);

		queue.run();
		await flush();

		expect(queue.item.status).toBe("completed");
		expect(queue.group.completed).toBe(1);
		expect(queue.group.status).toBe("completed");
	});

	test("a sync that wrote nothing does not", async () => {
		const queue = makeQueue(false);

		queue.run();
		await flush();

		expect(queue.item.status).toBe("failed");
		expect(queue.group.completed).toBe(0);
		expect(queue.group.status).toBe("failed");
	});
});
