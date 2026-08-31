/**
 * The record of what this device last agreed with, on a fake adapter.
 *
 * Everything here is about being wrong in the safe direction: an empty
 * record deletes nothing, and every way of failing to read one produces an
 * empty record rather than a guess.
 */

import { ObsidianSeenTree } from "../../src/knap/ObsidianSeenTree";

class FakeAdapter {
	files = new Map<string, string>();

	async read(path: string): Promise<string> {
		const found = this.files.get(path);
		if (found === undefined) throw new Error("ENOENT");
		return found;
	}
	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}
	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}
	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}
}

const PATH = ".obsidian/plugins/synced-vaults/knap-seen.json";

function treeFor(adapter: FakeAdapter, vaultId = "cloud-1") {
	return new ObsidianSeenTree(adapter as never, PATH, vaultId);
}

describe("ObsidianSeenTree", () => {
	it("hands back what it wrote down", async () => {
		const adapter = new FakeAdapter();
		const seen = treeFor(adapter);
		await seen.save(new Map([["Notes/plan.md", "doc-1"]]));

		expect(await treeFor(adapter).load()).toEqual(new Map([["Notes/plan.md", "doc-1"]]));
	});

	it("says nothing about a different cloud vault", async () => {
		// Reading one vault's record as another's is how linking to a second
		// cloud vault would start by deleting notes out of it.
		const adapter = new FakeAdapter();
		await treeFor(adapter, "cloud-1").save(new Map([["Notes/plan.md", "doc-1"]]));

		expect(await treeFor(adapter, "cloud-2").load()).toEqual(new Map());
	});

	it("a record that is not there, or not readable, is an empty one", async () => {
		const adapter = new FakeAdapter();
		expect(await treeFor(adapter).load()).toEqual(new Map());

		adapter.files.set(PATH, "{ this is not json");
		expect(await treeFor(adapter).load()).toEqual(new Map());
	});

	it("forgetting leaves nothing behind, and forgetting twice is fine", async () => {
		const adapter = new FakeAdapter();
		const seen = treeFor(adapter);
		await seen.save(new Map([["Notes/plan.md", "doc-1"]]));

		await seen.forget();
		await seen.forget();

		expect(adapter.files.has(PATH)).toBe(false);
		expect(await seen.load()).toEqual(new Map());
	});
});
