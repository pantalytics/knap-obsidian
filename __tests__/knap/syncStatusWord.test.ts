/**
 * The one word the engine puts on a vault, in the states no socket is open in.
 *
 * A vault that has an account and no cloud vault behind it read Up to date,
 * green, over notes that had never left the device. Nothing was syncing, so
 * nothing was behind, so the last branch won. That is #40's lie arriving by a
 * different road, and the fix is the word #42 already settled on for a vault
 * waiting to be told where it belongs.
 */

import { KnapSync } from "../../src/knap/KnapSync";
import type { KnapLink } from "../../src/knap/KnapSync";
import type { FileStore } from "../../src/knap/VaultBinding";
import { PAUSED, SIGNED_OUT, SYNCING, UP_TO_DATE } from "../../src/syncStatus";

/** Nothing here opens a socket or touches a file. */
const noFiles: FileStore = {
	read: async () => null,
	write: async () => {},
	remove: async () => {},
	rename: async () => {},
	listNotes: async () => [],
	onChange: () => () => {},
};

function syncFor(stored: KnapLink | null): KnapSync {
	return new KnapSync({
		serverUrl: "https://knap.test",
		deviceName: "Laptop",
		fetchFn: async () => new Response(null, { status: 204 }),
		files: noFiles,
		load: () => stored,
		save: async () => {},
	});
}

describe("what a vault with no link says it is doing", () => {
	it("reads Paused rather than Up to date, and wears the yellow dot", () => {
		const status = syncFor({ token: "knap_abc", cloudVaultId: "", cloudVaultName: "" }).status();

		expect(status.word).toBe(PAUSED);
		expect(status.dot).toBe("wait");
		// And it does not claim a vault it has not got.
		expect(status.vaultName).toBe("");
	});

	it("still puts the missing account first, because that is the fix to make", () => {
		expect(syncFor(null).status().word).toBe(SIGNED_OUT);
	});
});

/**
 * The word while the first pass is running, which is the fault a phone found.
 *
 * A vault linked on mobile said Up to date within seconds, green, with next
 * to none of its notes on the device. The only thing the word looked at was
 * the tree document, and one document settling says nothing about the two
 * thousand notes listed in it. That is #40, in the client that replaced the
 * code #40 was written against.
 */
describe("what a vault says while its notes are still arriving", () => {
	/** A linked, connected vault whose pass reports `busy`. */
	function syncFilling(busy: boolean, done: number, total: number): KnapSync {
		const sync = syncFor({ token: "knap_abc", cloudVaultId: "v1", cloudVaultName: "Work" });
		// The socket and the pass, stood in for. Reaching past `private` is
		// the point: what is pinned here is the wiring between the two, and
		// the alternative is a websocket in a unit test.
		const inside = sync as unknown as {
			client: { connected: boolean; settled: boolean; tree: () => { entries: () => Map<string, string> } };
			binding: { problems: number; progress: { busy: boolean; done: number; total: number } };
		};
		inside.client = {
			connected: true,
			// Settled: the tree is through its first exchange, which is where
			// the old reading stopped looking.
			settled: true,
			tree: () => ({ entries: () => new Map() }),
		};
		inside.binding = { problems: 0, progress: { busy, done, total } };
		return sync;
	}

	it("reads Syncing while the pass is still carrying notes", () => {
		const status = syncFilling(true, 290, 2567).status();

		expect(status.word).toBe(SYNCING);
		expect(status.dot).toBe("working");
	});

	it("hands the count on, so both screens can draw the same bar", () => {
		const status = syncFilling(true, 290, 2567).status();

		expect(status.done).toBe(290);
		expect(status.total).toBe(2567);
	});

	it("goes green once the pass is done, and stops counting", () => {
		const status = syncFilling(false, 0, 0).status();

		expect(status.word).toBe(UP_TO_DATE);
		expect(status.total).toBe(0);
	});
});
