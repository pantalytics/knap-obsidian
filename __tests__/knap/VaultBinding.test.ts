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
	SeenTree,
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

/** The tree this device last agreed with, surviving a restart in memory. */
class MemorySeen implements SeenTree {
	entries: Map<string, string> | null = null;

	async load(): Promise<Map<string, string>> {
		return new Map(this.entries ?? []);
	}
	async save(entries: Map<string, string>): Promise<void> {
		this.entries = new Map(entries);
	}
	async forget(): Promise<void> {
		this.entries = null;
	}
}

/** Relays updates between per-device docs, the way the server would. */
class Hub {
	private byId = new Map<string, Y.Doc[]>();

	/**
	 * How long the tree takes to arrive after its socket opens. Zero is the
	 * shape every test had before: the document is full the instant it is
	 * opened, which no websocket has ever managed. Set it and a device starts
	 * on an empty tree, which is what a real one does.
	 */
	treeDelay = 0;

	/** The tree as the server holds it. */
	treeOf(): Y.Map<string> {
		const peers = this.byId.get("tree") ?? [];
		return (peers[0] ?? new Y.Doc()).getMap<string>("files");
	}

	/** Every document that has ever been opened, minus the tree. */
	documentCount(): number {
		return [...this.byId.keys()].filter((id) => id !== "tree").length;
	}

	/** Point a path at a different document, with the given text in it. */
	repoint(path: string, docId: string, text: string): void {
		const doc = new Y.Doc();
		doc.getText("content").insert(0, text);
		const peers = this.byId.get(docId) ?? [];
		peers.push(doc);
		this.byId.set(docId, peers);
		this.treeOf().set(path, docId);
	}

	device(): VaultDocs {
		const mine = new Map<string, { doc: Y.Doc; synced: Promise<void> }>();
		let tree: TreeDoc | null = null;
		const open = (docId: string) => {
			let entry = mine.get(docId);
			if (!entry) {
				const doc = new Y.Doc();
				const peers = this.byId.get(docId) ?? [];
				const late = docId === "tree" && this.treeDelay > 0;
				const fill = () => {
					for (const peer of peers) {
						if (peer === doc) continue;
						Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
						Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
					}
				};
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
				let synced = Promise.resolve();
				if (late) {
					synced = new Promise<void>((resolve) =>
						setTimeout(() => {
							fill();
							resolve();
						}, this.treeDelay),
					);
				} else {
					fill();
				}
				entry = { doc, synced };
				mine.set(docId, entry);
			}
			return entry;
		};
		return {
			tree: () => (tree ??= new TreeDoc(open("tree").doc)),
			treeSynced: () => open("tree").synced,
			note: (docId: string) => open(docId),
		};
	}
}

async function device(hub: Hub, seed: Record<string, string> = {}, seen: SeenTree | null = null) {
	const files = new MemoryFiles();
	for (const [path, text] of Object.entries(seed)) files.map.set(path, text);
	const binding = new VaultBinding(files, hub.device(), () => "conflict", seen);
	await binding.start();
	return { files, binding };
}

/**
 * The same device, started again: the same disk, the same record, and fresh
 * documents, because a restart is exactly a set of sockets opening again.
 */
async function restart(hub: Hub, files: MemoryFiles, seen: SeenTree | null = null) {
	const binding = new VaultBinding(files, hub.device(), () => "conflict", seen);
	await binding.start();
	return binding;
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

	it("a device that starts before the tree arrives does not mint a second document", async () => {
		// Measured on production 2026-08-31: one note ended up with two
		// documents and then no name in the tree at all, and vanished from
		// every device. The binding reconciled against a tree that had not
		// synced yet, so every local file looked new.
		const hub = new Hub();
		const a = await device(hub, { "Welkom.md": "# Welkom\n" });
		await settle(a.binding);
		const first = a.binding ? hub.treeOf().get("Welkom.md") : undefined;

		hub.treeDelay = 5;
		const b = await device(hub, { "Welkom.md": "# Welkom\n" });
		await settle(a.binding, b.binding);

		expect(hub.treeOf().get("Welkom.md")).toBe(first);
		expect(hub.documentCount()).toBe(1);
	});

	it("a note whose tree entry changes id stays on disk and in the tree", async () => {
		// The other half of the same failure: an update to a tree entry was
		// reported as removed plus added, and the removed half deleted the
		// file. The delete event that followed then took the path out of the
		// tree on every device.
		const hub = new Hub();
		const a = await device(hub, { "Welkom.md": "# Welkom\n" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		// Somebody points the path at a different document, the way a device
		// starting on an empty tree used to.
		hub.repoint("Welkom.md", "1111ffff2222aaaa3333bbbb4444cccc", "# Welkom\n");
		await settle(a.binding, b.binding);

		expect(a.files.map.has("Welkom.md")).toBe(true);
		expect(b.files.map.has("Welkom.md")).toBe(true);
		expect(hub.treeOf().has("Welkom.md")).toBe(true);
	});

	it("a tree that never arrives fails the link with a sentence, not a hang", async () => {
		// The cost of waiting for the tree: a socket that never syncs would
		// leave the Link button waiting with nothing on screen.
		jest.useFakeTimers();
		try {
			const hub = new Hub();
			hub.treeDelay = 10 * 60 * 1000; // longer than the binding waits
			const files = new MemoryFiles();
			const binding = new VaultBinding(files, hub.device(), () => "conflict");
			const started = binding.start();
			const caught = started.catch((error: Error) => error.message);
			await jest.advanceTimersByTimeAsync(31_000);

			await expect(caught).resolves.toContain("Could not reach the server");
		} finally {
			jest.useRealTimers();
		}
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

	it("deleting a folder takes the notes in it out of the tree", async () => {
		// Obsidian's delete event for a folder names the folder and not the
		// notes in it. Left at that, the notes stayed in the tree and came
		// straight back down onto the disk they had just been deleted from.
		const hub = new Hub();
		const a = await device(hub, {
			"Map/een.md": "x",
			"Map/twee.md": "y",
			"los.md": "z",
		});
		const b = await device(hub);
		await settle(a.binding, b.binding);

		a.files.map.delete("Map/een.md");
		a.files.map.delete("Map/twee.md");
		a.files.emit({ type: "delete", path: "Map" });
		await settle(a.binding, b.binding);

		expect(hub.treeOf().has("Map/een.md")).toBe(false);
		expect(b.files.map.has("Map/twee.md")).toBe(false);
		expect(b.files.map.get("los.md")).toBe("z");
	});

	it("a note deleted while the plugin was not running is deleted in the cloud vault", async () => {
		// The delete somebody makes with Obsidian closed, or with the plugin
		// off, or on a laptop that never got back online before it was shut.
		// No event ever fires for it, so the only trace is a file that is not
		// where the record says it was.
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "weg.md": "x", "blijft.md": "y" }, seen);
		const b = await device(hub);
		await settle(a.binding, b.binding);
		expect(b.files.map.get("weg.md")).toBe("x");

		a.binding.stop();
		a.files.map.delete("weg.md");

		const back = await restart(hub, a.files, seen);
		await settle(back, b.binding);

		expect(hub.treeOf().has("weg.md")).toBe(false);
		expect(a.files.map.has("weg.md")).toBe(false);
		expect(b.files.map.has("weg.md")).toBe(false);
		expect(b.files.map.get("blijft.md")).toBe("y");
	});

	it("a note deleted in the cloud vault while the device was away goes from its disk", async () => {
		// The same fact from the other end: this device kept the note, so on
		// the next start it used to upload it again under a new document and
		// undo somebody else's delete on every device.
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "weg.md": "x" }, seen);
		const b = await device(hub);
		await settle(a.binding, b.binding);

		a.binding.stop();
		await b.files.remove("weg.md");
		await settle(b.binding);

		const back = await restart(hub, a.files, seen);
		await settle(back, b.binding);

		expect(a.files.map.has("weg.md")).toBe(false);
		expect(hub.treeOf().has("weg.md")).toBe(false);
	});

	it("a note that arrived while the device was away is still downloaded", async () => {
		// The record may only speak about notes it has seen. Reading a note
		// it has never heard of as a deletion is how this would eat the work
		// of every other device.
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "eigen.md": "x" }, seen);
		const b = await device(hub);
		await settle(a.binding, b.binding);

		a.binding.stop();
		await b.files.write("nieuw.md", "van B");
		await settle(b.binding);

		const back = await restart(hub, a.files, seen);
		await settle(back, b.binding);

		expect(a.files.map.get("nieuw.md")).toBe("van B");
		expect(a.files.map.get("eigen.md")).toBe("x");
	});

	it("a vault whose files have not loaded deletes nothing", async () => {
		// A vault Obsidian is still opening answers "which notes are here"
		// with too few, and a vault somebody emptied answers it with none.
		// The two are the same answer, and only one of them is worth acting
		// on, so the empty one is not acted on at all.
		const hub = new Hub();
		const seen = new MemorySeen();
		const a = await device(hub, { "een.md": "x", "twee.md": "y" }, seen);
		await settle(a.binding);
		a.binding.stop();

		const unloaded = new MemoryFiles();
		const back = await restart(hub, unloaded, seen);
		await settle(back);

		expect(hub.treeOf().has("een.md")).toBe(true);
		expect(hub.treeOf().has("twee.md")).toBe(true);
		expect(unloaded.map.get("een.md")).toBe("x");
	});

	it("without a record a restart deletes nothing on either side", async () => {
		// A device linking for the first time, and every device before this
		// record existed: a missing file is a note that has not arrived yet,
		// so it arrives. Nothing is deleted anywhere on the strength of a
		// guess.
		const hub = new Hub();
		const a = await device(hub, { "weg.md": "x" });
		await settle(a.binding);

		a.binding.stop();
		a.files.map.delete("weg.md");

		const back = await restart(hub, a.files);
		await settle(back);

		expect(hub.treeOf().has("weg.md")).toBe(true);
		expect(a.files.map.get("weg.md")).toBe("x");
	});

	it("a note arriving where an unsynced local file sits keeps both", async () => {
		// Not link time: B is already linked and typing, and A makes a note of
		// the same name on the other side of the world. The tree change reaches
		// B with a file already at that path, and writing over it would be the
		// one thing this binding promises never to do.
		const hub = new Hub();
		const a = await device(hub);
		const b = await device(hub);
		await settle(a.binding, b.binding);

		b.files.map.set("Notes/idee.md", "wat ik zelf had");
		await a.files.write("Notes/idee.md", "wat zij schreef");
		await settle(a.binding, b.binding);

		expect(b.files.map.get("Notes/idee.md")).toBe("wat zij schreef");
		const copies = [...b.files.map].filter(([path]) => path.includes("conflict"));
		expect(copies).toHaveLength(1);
		expect(copies[0][1]).toBe("wat ik zelf had");
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

	it("stands down for a note an editor is holding, and catches the file up after", async () => {
		const hub = new Hub();
		const a = await device(hub, { "open.md": "eerste regel\n" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		// Obsidian opens the note here: from now on the editor writes this
		// file, so a remote change may not be written over its buffer.
		const release = a.binding.hold("open.md");
		const docId = hub.device().tree().docIdFor("open.md");
		expect(docId).toBeTruthy();

		await b.files.write("open.md", "eerste regel\ntweede regel\n");
		await settle(a.binding, b.binding);
		expect(a.files.map.get("open.md")).toBe("eerste regel\n");

		// The editor closes: the file is brought up to date once, here.
		release();
		await settle(a.binding);
		expect(a.files.map.get("open.md")).toBe("eerste regel\ntweede regel\n");
	});

	it("ignores the save event of a held note, whose editor is already ahead", async () => {
		const hub = new Hub();
		const a = await device(hub, { "open.md": "een\ntwee\n" });
		const b = await device(hub);
		await settle(a.binding, b.binding);

		const release = a.binding.hold("open.md");
		// The other device adds a line while this editor holds the note.
		await b.files.write("open.md", "een\ntwee\ndrie van B\n");
		await settle(a.binding, b.binding);

		// The file here is a save behind the buffer somebody is typing in,
		// which is the ordinary state of an open note. Set rather than
		// written, because a write is what Obsidian is doing, not us.
		a.files.map.set("open.md", "een\ntwee\n");
		// And now Obsidian saves. Without the stand-down this splices the
		// other device's line back out of the document for everybody.
		a.files.emit({ type: "modify", path: "open.md" });
		await settle(a.binding, b.binding);
		expect(b.files.map.get("open.md")).toBe("een\ntwee\ndrie van B\n");

		release();
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
