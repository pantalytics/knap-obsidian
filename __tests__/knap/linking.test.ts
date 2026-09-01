/**
 * What a link does while it is being made, which is where this went wrong.
 *
 * Measured on a phone on 2026-09-01: somebody signed in, chose their personal
 * cloud vault, and the settings page went on saying *Not linked* while the
 * first pass worked through the vault. Nothing on screen moved, so they chose
 * it again, and the second attempt tore the first one down half way. What
 * reached them was two notices reading *This vault is not linked any more.*
 * over a link they had just asked for, and a page that still said Not linked.
 *
 * So the claims here are the two halves of ADR-0086. A link settles when the
 * cloud vault answers, with the first pass running on behind it. And a second
 * press for the same vault is the same act: it joins the link that is already
 * being made rather than replacing it.
 */

import { KnapSync } from "../../src/knap/KnapSync";
import type { KnapLink } from "../../src/knap/KnapSync";
import { SYNCING, UP_TO_DATE } from "../../src/syncStatus";
import { FakeNetwork, MemoryFiles, roomOf } from "../mocks/knapNetwork";

/** A vault whose listing does not answer until a test lets it. */
class GatedFiles extends MemoryFiles {
	private open: (() => void) | null = null;
	private held = new Promise<void>((resolve) => {
		this.open = resolve;
	});

	/** Let the first pass past the gate. */
	release(): void {
		this.open?.();
	}

	override async listNotes(): Promise<string[]> {
		await this.held;
		return super.listNotes();
	}
}

function syncWith(files: MemoryFiles, network: FakeNetwork) {
	let held: KnapLink | null = { token: "knap_abc", cloudVaultId: "", cloudVaultName: "" };
	const sync = new KnapSync({
		serverUrl: "https://knap.test",
		deviceName: "Phone",
		fetchFn: async () => new Response("{}"),
		files,
		load: () => held,
		save: async (value) => {
			held = value;
		},
		webSocket: network.socket,
	});
	return sync;
}

const WORK = { id: "v1", name: "Work notes" };

describe("linking a cloud vault", () => {
	jest.setTimeout(30_000);
	process.setMaxListeners(0);

	it("is made when the cloud vault answers, not when every note has travelled", async () => {
		const network = new FakeNetwork();
		const files = new GatedFiles();
		files.map.set("Notes/one.md", "# One\n");
		files.map.set("Notes/two.md", "# Two\n");
		const sync = syncWith(files, network);

		// The pass cannot get past listNotes, so this is a link with all of
		// its filling still ahead of it.
		await sync.link(WORK);

		expect(sync.linked?.cloudVaultId).toBe("v1");
		expect(sync.running).toBe(true);
		expect(sync.linking).toBe("");
		// Nothing has gone up yet, which is the whole point of the claim.
		expect(sync.status().notes).toBe(0);
		// And the bar says so rather than claiming the vault is up to date.
		expect(sync.status().word).toBe(SYNCING);

		files.release();
		await new Promise((resolve) => setTimeout(resolve, 300));

		const tree = sync.status();
		expect(tree.notes).toBe(2);
		expect(tree.word).toBe(UP_TO_DATE);
		expect(tree.problems).toBe(0);

		sync.stop();
	});

	it("names the cloud vault it is linking to while it is doing it", async () => {
		const network = new FakeNetwork();
		const files = new GatedFiles();
		const sync = syncWith(files, network);

		const linking = sync.link(WORK);
		expect(sync.linking).toBe("Work notes");
		expect(sync.status().word).toBe(SYNCING);
		expect(sync.status().vaultName).toBe("Work notes");

		files.release();
		await linking;
		expect(sync.linking).toBe("");

		sync.stop();
	});

	it("tells the screen at each step without being asked twice", async () => {
		const network = new FakeNetwork();
		const files = new GatedFiles();
		const sync = syncWith(files, network);
		let told = 0;
		const stop = sync.onChange(() => {
			told += 1;
		});

		files.release();
		await sync.link(WORK);
		expect(told).toBeGreaterThan(0);

		const sofar = told;
		stop();
		await sync.unlink();
		expect(told).toBe(sofar);

		sync.stop();
	});

	it("joins a link already being made rather than replacing it half way", async () => {
		// The second press, which used to call stop() on a client the first
		// press was still using and reach the person as "This vault is not
		// linked any more."
		const network = new FakeNetwork();
		const files = new GatedFiles();
		files.map.set("Notes/one.md", "# One\n");
		const sync = syncWith(files, network);

		const first = sync.link(WORK);
		const second = sync.link(WORK);
		files.release();
		await Promise.all([first, second]);

		// One client, one tree, one connection to it.
		expect(network.opens.get(roomOf("v1", "tree"))).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(sync.status().problems).toBe(0);
		expect(sync.status().notes).toBe(1);

		sync.stop();
	});

	it("refuses a second cloud vault while the first is still coming up", async () => {
		const network = new FakeNetwork();
		const files = new GatedFiles();
		const sync = syncWith(files, network);

		const first = sync.link(WORK);
		await expect(sync.link({ id: "v2", name: "Tuinplannen" })).rejects.toThrow(
			"Still linking to Work notes",
		);

		files.release();
		await first;
		expect(sync.linked?.cloudVaultName).toBe("Work notes");

		sync.stop();
	});

	it("says so, and keeps the link, when the cloud vault never answers", async () => {
		jest.useFakeTimers();
		try {
			const network = new FakeNetwork();
			network.deaf = true;
			const sync = syncWith(new MemoryFiles(), network);

			const linking = sync.link(WORK);
			const settled = expect(linking).rejects.toThrow("Could not reach the cloud vault");
			await jest.advanceTimersByTimeAsync(31_000);
			await settled;

			// Kept, because linking replaced whatever was there (ADR-0066) and
			// a link that cannot be reached is still the link this vault has.
			expect(sync.linked?.cloudVaultName).toBe("Work notes");
			expect(sync.linking).toBe("");

			sync.stop();
		} finally {
			jest.useRealTimers();
		}
	});
});
