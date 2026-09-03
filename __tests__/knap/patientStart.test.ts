/**
 * Obsidian starts and the server is away: a laptop on a train, or a deploy
 * in progress on the other end.
 *
 * Until 2026-09-02 the start gave up on the tree after half a minute and the
 * notice said it would retry at the next sign-in, which nothing did. Once the
 * server was back the socket reconnected on its own, the tree settled, and
 * the status read Up to date over a binding that had never been built. A
 * start nobody is watching now waits, the word says Offline while it does,
 * and the pass runs when the tree arrives.
 */

import { KnapSync, type KnapLink } from "../../src/knap/KnapSync";
import { TREE_DOC_ID, TreeDoc } from "../../src/knap/TreeDoc";
import { OFFLINE, UP_TO_DATE } from "../../src/syncStatus";
import { FakeNetwork, MemoryFiles } from "../mocks/fakeNetwork";

const answers = async (url: string) => {
	if (url.endsWith("/api/me")) {
		return new Response(JSON.stringify({ subject: "s1", email: "iris@example.test" }));
	}
	return new Response(
		JSON.stringify({ max_attachment_bytes: 10_000_000, max_vault_bytes: 1_000_000_000 }),
	);
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await wait(20);
	}
}

function engine(network: FakeNetwork, files: MemoryFiles, stored: KnapLink | null) {
	let held = stored;
	const sync = new KnapSync({
		serverUrl: "https://knap.test",
		deviceName: "Laptop",
		fetchFn: answers,
		files,
		load: () => held,
		save: async (value) => {
			held = value;
		},
		webSocket: network.socket,
	});
	return sync;
}

const linked: KnapLink = {
	token: "knap_abc",
	cloudVaultId: "v1",
	cloudVaultName: "Work notes",
	initialized: true,
};

describe("a start while the server is away", () => {
	jest.setTimeout(30_000);
	process.setMaxListeners(0);

	it("waits, says Offline, and fills the vault once the server is back", async () => {
		const network = new FakeNetwork();
		network.down = true;
		const room = `/sync/v1/${TREE_DOC_ID}`;
		const tree = new TreeDoc(network.doc(room));
		tree.ensureNote("Cloud/a.md");
		const files = new MemoryFiles();
		const sync = engine(network, files, linked);
		jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
		try {
			const started = sync.start();
			let settled = false;
			void started.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			// Well past the deadline a watched start gives up at. The socket
			// has failed and been retried a number of times by now.
			await jest.advanceTimersByTimeAsync(31_000);
			expect(settled).toBe(false);
			expect(network.opens.get(room) ?? 0).toBeGreaterThan(3);
			expect(sync.running).toBe(false);
			expect(sync.status().word).toBe(OFFLINE);

			network.down = false;
			for (let i = 0; i < 100 && !settled; i++) {
				await jest.advanceTimersByTimeAsync(100);
			}
			await started;
			expect(sync.running).toBe(true);
			expect(files.map.has("Cloud/a.md")).toBe(true);
			expect(sync.status().word).toBe(UP_TO_DATE);
		} finally {
			jest.useRealTimers();
			sync.stop();
		}
	});

	it("ends quietly when the link is taken down while it waits", async () => {
		const network = new FakeNetwork();
		network.down = true;
		const files = new MemoryFiles();
		const sync = engine(network, files, linked);

		const started = sync.start();
		await until(() => (network.opens.get(`/sync/v1/${TREE_DOC_ID}`) ?? 0) >= 1);
		await sync.unlink();

		// Not a failure of the start: nobody is told the server was away
		// over a link they just ended themselves.
		await expect(started).resolves.toBeUndefined();
		expect(sync.running).toBe(false);
		expect(sync.linked).toBeNull();
	});

	it("still gives up on a watched start, because a person is looking at it", async () => {
		const network = new FakeNetwork();
		network.down = true;
		const files = new MemoryFiles();
		const sync = engine(network, files, linked);
		jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
		try {
			const started = sync.start(() => undefined);
			const outcome = started.then(
				() => "resolved",
				(error: Error) => error.message,
			);
			await jest.advanceTimersByTimeAsync(31_000);
			expect(await outcome).toBe("Could not reach the server. Nothing was changed; try again.");
		} finally {
			jest.useRealTimers();
			sync.stop();
		}
	});
});
