/**
 * A BRAT update, which is not a restart: the plugin is disabled and enabled
 * again while Obsidian keeps running.
 *
 * Measured against BRAT's own `writeReleaseFilesToPluginFolder` on
 * 2026-09-02: it overwrites `main.js`, `manifest.json` and `styles.css` and
 * touches nothing else in the plugin's directory, then calls `disablePlugin`
 * followed by `enablePlugin`. So `data.json` survives an update, and so does
 * `knap-seen.json` beside it. Both are modelled here as the same objects
 * handed to the second engine, because on disk that is what they are.
 *
 * Which leaves one question, and it is the one somebody watching a first
 * sync asks: does an update send this vault back to the beginning? It does
 * not. The account, the link and the record of the first pass are all facts
 * on disk, and the second engine reads the same three.
 *
 * The pair of tests is the pair of honest answers. An update after the first
 * pass comes back Up to date. An update during one comes back Initializing,
 * because the pass really is unfinished, and the second one is as much the
 * point as the first: the word says where the vault is, not how many times
 * the plugin has loaded.
 */

import { KnapSync, type KnapLink } from "../../src/knap/KnapSync";
import { TREE_DOC_ID, TreeDoc } from "../../src/knap/TreeDoc";
import type { SeenTree } from "../../src/knap/VaultBinding";
import { INITIALIZING, UP_TO_DATE } from "../../src/syncStatus";
import { FakeNetwork, MemoryFiles } from "../mocks/fakeNetwork";

const answers = async (url: string) => {
	if (url.endsWith("/api/me")) {
		return new Response(JSON.stringify({ subject: "s1", email: "iris@example.test" }));
	}
	return new Response(
		JSON.stringify({ max_attachment_bytes: 10_000_000, max_vault_bytes: 1_000_000_000 }),
	);
};

function fillCloud(network: FakeNetwork, vaultId: string, notes: string[]): void {
	const tree = new TreeDoc(network.doc(`/sync/${vaultId}/${TREE_DOC_ID}`));
	for (const path of notes) tree.ensureNote(path);
}

/** `knap-seen.json`, which lives beside the plugin and outlives its bundle. */
class MemorySeen implements SeenTree {
	entries = new Map<string, string>();
	async load(): Promise<Map<string, string>> {
		return new Map(this.entries);
	}
	async save(entries: Map<string, string>): Promise<void> {
		this.entries = new Map(entries);
	}
	async forget(): Promise<void> {
		this.entries = new Map();
	}
}

/**
 * One vault's worth of disk: the settings blob and the seen record, both of
 * which a bundle reads at load and neither of which an update rewrites.
 */
function disk(stored: KnapLink | null) {
	let held = stored;
	const seen = new MemorySeen();
	const engine = (network: FakeNetwork, files: MemoryFiles) =>
		new KnapSync({
			serverUrl: "https://knap.test",
			deviceName: "Laptop",
			fetchFn: answers,
			files,
			load: () => held,
			save: async (value) => {
				held = value;
			},
			webSocket: network.socket,
			makeSeen: () => seen,
		});
	return { engine, held: () => held, seen };
}

describe("an update while Obsidian is running", () => {
	jest.setTimeout(30_000);
	process.setMaxListeners(0);

	it("comes back signed in, linked and up to date once the first pass is done", async () => {
		const network = new FakeNetwork();
		fillCloud(network, "v1", ["Cloud/a.md", "Cloud/b.md"]);
		const files = new MemoryFiles();
		const { engine, held, seen } = disk({
			token: "knap_abc",
			cloudVaultId: "",
			cloudVaultName: "",
		});

		const before = engine(network, files);
		await before.link({ id: "v1", name: "Work notes" });
		expect(before.status().word).toBe(UP_TO_DATE);
		await Promise.resolve();
		expect(held()?.initialized).toBe(true);
		const remembered = seen.entries.size;

		// The update: the old bundle is unloaded, the new one loads and
		// reads the same disk.
		before.stop();
		const after = engine(network, files);
		await after.start();

		expect(after.signedIn).toBe(true);
		expect(after.linked?.cloudVaultId).toBe("v1");
		expect(after.status().vaultName).toBe("Work notes");
		// Not Initializing: the vault has been through its pass and the
		// settings say so, so the second load has nothing to announce.
		expect(after.status().word).toBe(UP_TO_DATE);
		// And nothing was re-fetched into a vault that already held it.
		expect(files.map.size).toBe(2);
		expect(seen.entries.size).toBe(remembered);

		after.stop();
	});

	it("comes back Initializing when the update lands mid first pass", async () => {
		const network = new FakeNetwork();
		fillCloud(network, "v1", ["Cloud/a.md"]);
		const files = new MemoryFiles();
		// A link made by a bundle that was replaced before the vault ever
		// fell quiet, which is what a settings row looks like at that moment.
		const { engine, held } = disk({
			token: "knap_abc",
			cloudVaultId: "v1",
			cloudVaultName: "Work notes",
			initialized: false,
		});

		const after = engine(network, files);
		const words: string[] = [];
		await after.start((step) => {
			if (step === "linked") words.push(after.status().word);
		});

		expect(after.signedIn).toBe(true);
		expect(after.linked?.cloudVaultId).toBe("v1");
		// The word the second load carries through the pass it inherited.
		expect(words).toEqual([INITIALIZING]);
		// It gives way on its own, once that pass is done, and this time the
		// settings keep it.
		expect(after.status().word).toBe(UP_TO_DATE);
		await Promise.resolve();
		expect(held()?.initialized).toBe(true);

		after.stop();
	});
});
