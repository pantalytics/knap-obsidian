/**
 * The binding engine, on real Yjs docs and an in-memory file store.
 *
 * Two devices hang off one hub that relays updates the way the server
 * does, so every claim about convergence is a claim about two bindings
 * ending up with the same files. The file store fires events for the
 * binding's own writes too, exactly like Obsidian's vault does, which is
 * what makes the no-echo tests honest.
 */

import * as Y from "yjs";

import { TreeDoc } from "../../src/knap/TreeDoc";
import {
	FileEvent,
	FileStore,
	VaultBinding,
	VaultDocs,
	splice,
} from "../../src/knap/VaultBinding";

class MemoryFiles implements FileStore {
	map = new Map<string, string>();
	listeners: ((event: FileEvent) => void)[] = [];
	writes = 0;

	async read(path: string): Promise<string | null> {
		return this.map.has(path) ? (this.map.get(path) as string) : null;
	}
	async write(path: string, text: string): Promise<void> {
		const existed = this.map.has(path);
		this.map.set(path, text);
		this.writes++;
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
	async listNotes(): Promise<string[]> {
		return [...this.map.keys()].filter((p) => p.endsWith(".md"));
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

/** Relays updates between per-device docs, the way the server would. */
class Hub {
	private byId = new Map<string, Y.Doc[]>();

	device(): VaultDocs {
		const mine = new Map<string, { doc: Y.Doc; synced: Promise<void> }>();
		let tree: TreeDoc | null = null;
		const open = (docId: string) => {
			let entry = mine.get(docId);
			if (!entry) {
				const doc = new Y.Doc();
				const peers = this.byId.get(docId) ?? [];
				for (const peer of peers) {
					Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
					Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
				}
				const relay = (source: Y.Doc, targets: () => Y.Doc[]) => {
					source.on("update", (update: Uint8Array, origin: unknown) => {
						if (origin === "hub") return;
						for (const target of targets()) {
							if (target !== source) Y.applyUpdate(target, update, "hub");
						}
					});
				};
				peers.push(doc);
				this.byId.set(docId, peers);
				relay(doc, () => this.byId.get(docId) ?? []);
				entry = { doc, synced: Promise.resolve() };
				mine.set(docId, entry);
			}
			return entry;
		};
		return {
			tree: () => (tree ??= new TreeDoc(open("tree").doc)),
			note: (docId: string) => open(docId),
		};
	}
}

async function device(hub: Hub, seed: Record<string, string> = {}) {
	const files = new MemoryFiles();
	for (const [path, text] of Object.entries(seed)) files.map.set(path, text);
	const binding = new VaultBinding(files, hub.device(), () => "conflict");
	await binding.start();
	return { files, binding };
}

const settle = async (...bindings: VaultBinding[]) => {
	// Event chains hop between queues, so settle twice around a microtask turn.
	for (let round = 0; round < 3; round++) {
		for (const binding of bindings) await binding.flush();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

describe("VaultBinding", () => {
	it("uploads local notes at link time, and a second device receives them", async () => {
		const hub = new Hub();
		const a = await device(hub, { "Notes/plan.md": "# Plan\n" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		expect(b.files.map.get("Notes/plan.md")).toBe("# Plan\n");
	});

	it("downloads remote notes at link time", async () => {
		const hub = new Hub();
		const a = await device(hub, { "een.md": "inhoud" });
		await settle(a.binding);
		const b = await device(hub);
		await settle(b.binding);

		expect(b.files.map.get("een.md")).toBe("inhoud");
	});

	it("a local edit reaches the other device as a merge, not a steamroll", async () => {
		const hub = new Hub();
		const a = await device(hub, { "samen.md": "regel1\nregel2\nregel3\n" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		// Both devices edit different lines of the same note, "offline".
		await a.files.write("samen.md", "regel1 door A\nregel2\nregel3\n");
		await settle(a.binding, b.binding);
		await b.files.write("samen.md", "regel1 door A\nregel2\nregel3 door B\n");
		await settle(a.binding, b.binding);

		expect(a.files.map.get("samen.md")).toBe("regel1 door A\nregel2\nregel3 door B\n");
		expect(a.files.map.get("samen.md")).toBe(b.files.map.get("samen.md"));
	});

	it("a rename travels as a tree move and the other device follows", async () => {
		const hub = new Hub();
		const a = await device(hub, { "oud.md": "tekst" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		await a.files.rename("oud.md", "Archief/nieuw.md");
		await settle(a.binding, b.binding);

		expect(b.files.map.has("oud.md")).toBe(false);
		expect(b.files.map.get("Archief/nieuw.md")).toBe("tekst");
	});

	it("a delete leaves the tree and the other device's disk", async () => {
		const hub = new Hub();
		const a = await device(hub, { "weg.md": "x" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		await a.files.remove("weg.md");
		await settle(a.binding, b.binding);

		expect(b.files.map.has("weg.md")).toBe(false);
	});

	it("link-time conflict keeps the cloud text and saves the local text beside it", async () => {
		const hub = new Hub();
		const a = await device(hub, { "nota.md": "cloudversie" });
		await settle(a.binding);

		const b = await device(hub, { "nota.md": "lokale versie" });
		await settle(a.binding, b.binding);

		expect(b.files.map.get("nota.md")).toBe("cloudversie");
		expect(b.files.map.get("nota (conflict).md")).toBe("lokale versie");
		// The conflict copy is a new note like any other: it syncs too.
		expect(a.files.map.get("nota (conflict).md")).toBe("lokale versie");
	});

	it("its own writes do not echo", async () => {
		const hub = new Hub();
		const a = await device(hub, { "stil.md": "rust" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		const before = { a: a.files.writes, b: b.files.writes };
		await settle(a.binding, b.binding);
		await settle(a.binding, b.binding);
		expect(a.files.writes).toBe(before.a);
		expect(b.files.writes).toBe(before.b);
	});

	it("only markdown is bound; other files stay local", async () => {
		const hub = new Hub();
		const a = await device(hub, { "foto.png": "bytes", "echt.md": "note" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		expect(b.files.map.has("echt.md")).toBe(true);
		expect(b.files.map.has("foto.png")).toBe(false);
	});
});

describe("splice", () => {
	it("touches only the changed range", () => {
		const doc = new Y.Doc();
		const text = doc.getText("content");
		text.insert(0, "aaa MIDDEN zzz");
		splice(text, "aaa MIDDEN zzz", "aaa NIEUW zzz", doc);
		expect(text.toString()).toBe("aaa NIEUW zzz");
	});

	it("survives emoji and accents on UTF-16 boundaries", () => {
		const doc = new Y.Doc();
		const text = doc.getText("content");
		const before = "café ☕ plan 🚀 einde";
		text.insert(0, before);
		splice(text, before, "café ☕ plan 🚀🚀 einde", doc);
		expect(text.toString()).toBe("café ☕ plan 🚀🚀 einde");
	});
});
