/**
 * What the gauge behind the corner of the window counts, and what it refuses
 * to count.
 *
 * Three things move notes and the two that can be counted are the ones that
 * are worth a number: notes still to reach the cloud vault, and notes still to
 * reach this device. An edit to a note both sides already have is the third,
 * and it never touches the gauge, because a number that goes 1, 0, 1, 0 while
 * somebody types is what made the old corner unreadable (ADR-0088).
 */

import * as Y from "yjs";

import { TreeDoc } from "../../src/knap/TreeDoc";
import type { FileEvent, FileStore, VaultDocs } from "../../src/knap/VaultBinding";
import { VaultBinding } from "../../src/knap/VaultBinding";

class MemoryFiles implements FileStore {
	map = new Map<string, string>();
	listeners: ((event: FileEvent) => void)[] = [];
	/** Called on every read, which is where a fill spends its time. */
	onRead: (path: string) => void = () => undefined;

	async read(path: string): Promise<string | null> {
		this.onRead(path);
		return this.map.has(path) ? (this.map.get(path) as string) : null;
	}
	async write(path: string, text: string): Promise<void> {
		const existed = this.map.has(path);
		this.map.set(path, text);
		this.emit({ type: existed ? "modify" : "create", path });
	}
	async remove(path: string): Promise<void> {
		this.map.delete(path);
		this.emit({ type: "delete", path });
	}
	async rename(from: string, to: string): Promise<void> {
		const text = this.map.get(from) ?? "";
		this.map.delete(from);
		this.map.set(to, text);
		this.emit({ type: "rename", path: to, oldPath: from });
	}
	async readBinary(): Promise<ArrayBuffer | null> {
		return null;
	}
	async writeBinary(): Promise<void> {
		throw new Error("This store holds notes.");
	}
	async listNotes(): Promise<string[]> {
		return [...this.map.keys()].filter((p) => p.endsWith(".md"));
	}
	async listAttachments(): Promise<string[]> {
		return [];
	}
	onChange(callback: (event: FileEvent) => void): () => void {
		this.listeners.push(callback);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== callback);
		};
	}
	emit(event: FileEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}

/** One device's documents, all local: this file is about counting, not sync. */
function docs(seed: Record<string, string> = {}): VaultDocs {
	const open = new Map<string, Y.Doc>();
	const treeDoc = new Y.Doc();
	const tree = new TreeDoc(treeDoc);
	for (const [path, text] of Object.entries(seed)) {
		const docId = tree.ensureNote(path);
		const doc = new Y.Doc();
		doc.getText("content").insert(0, text);
		open.set(docId, doc);
	}
	return {
		tree: () => tree,
		treeSynced: () => Promise.resolve(),
		withNote: async <T,>(docId: string, use: (note: { doc: Y.Doc }) => Promise<T>) => {
			let doc = open.get(docId);
			if (!doc) open.set(docId, (doc = new Y.Doc()));
			return use({ doc });
		},
		onNoteClosed: () => () => undefined,
	};
}

const settle = async (binding: VaultBinding) => {
	for (let round = 0; round < 3; round++) {
		await binding.flush();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

describe("the two gauges", () => {
	it("counts every note of a first upload before it starts sending them", async () => {
		const files = new MemoryFiles();
		for (let i = 0; i < 20; i++) files.map.set(`note-${i}.md`, `body ${i}`);
		const binding = new VaultBinding(files, docs());
		// The fill works eight notes at a time, so a gauge that went up as
		// each one started would say eight over a vault of twenty.
		const seen: number[] = [];
		files.onRead = () => seen.push(binding.backlog.up);

		await binding.start();
		await settle(binding);

		expect(Math.max(...seen)).toBe(20);
		expect(seen.every((n) => n > 0)).toBe(true);
		// And it is empty again once the last one has landed.
		expect(binding.backlog).toEqual({ up: 0, down: 0 });
	});

	it("counts notes the cloud vault has and this device has not", async () => {
		const files = new MemoryFiles();
		const binding = new VaultBinding(files, docs({ "a.md": "A", "b.md": "B" }));
		const seen: number[] = [];
		files.onRead = () => seen.push(binding.backlog.down);

		await binding.start();
		await settle(binding);

		expect(Math.max(...seen)).toBe(2);
		expect(files.map.get("a.md")).toBe("A");
		expect(binding.backlog).toEqual({ up: 0, down: 0 });
	});

	it("never counts a note the tree already knows, which is every edit", async () => {
		const files = new MemoryFiles();
		files.map.set("plan.md", "# Plan\n");
		const binding = new VaultBinding(files, docs());
		await binding.start();
		await settle(binding);
		expect(binding.backlog).toEqual({ up: 0, down: 0 });

		// Typing in it: the same path, a document that already exists.
		const seen: number[] = [];
		files.onRead = () => seen.push(binding.backlog.up);
		files.map.set("plan.md", "# Plan\nand a line\n");
		files.emit({ type: "modify", path: "plan.md" });
		await settle(binding);

		expect(seen.length).toBeGreaterThan(0);
		expect(Math.max(...seen)).toBe(0);
	});

	it("counts a note that is genuinely new here, which is not an edit", async () => {
		const files = new MemoryFiles();
		const binding = new VaultBinding(files, docs());
		await binding.start();
		await settle(binding);

		const seen: number[] = [];
		files.onRead = () => seen.push(binding.backlog.up);
		files.map.set("new.md", "fresh");
		files.emit({ type: "create", path: "new.md" });
		await settle(binding);

		expect(Math.max(...seen)).toBe(1);
		expect(binding.backlog).toEqual({ up: 0, down: 0 });
	});
});
