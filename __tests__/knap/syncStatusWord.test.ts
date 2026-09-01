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
import { PAUSED, SIGNED_OUT } from "../../src/syncStatus";

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
