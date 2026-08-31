/**
 * The attachment engine, on real Yjs docs and an in-memory pair of stores.
 *
 * Same shape as VaultBinding.test.ts and for the same reason: two devices
 * hang off one hub that relays updates the way the server does, and one
 * in-memory file store per device that fires events for the binding's own
 * writes, exactly like Obsidian's vault. A third store stands in for the
 * file routes, so "the bytes arrived" is a claim about a transfer rather
 * than about a mock being called.
 */

import * as Y from "yjs";

import {
	AttachmentBinding,
	AttachmentLimits,
	AttachmentTransport,
	FALLBACK_LIMITS,
	readable,
} from "../../src/knap/AttachmentBinding";
import { TreeDoc } from "../../src/knap/TreeDoc";
import { FileEvent, FileStore } from "../../src/knap/VaultBinding";

function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function textOf(content: ArrayBuffer): string {
	return new TextDecoder().decode(content);
}

/** Obsidian's vault, in memory: text and bytes, and events for both. */
class MemoryFiles implements FileStore {
	notes = new Map<string, string>();
	blobs = new Map<string, ArrayBuffer>();
	listeners: ((event: FileEvent) => void)[] = [];

	async read(path: string): Promise<string | null> {
		return this.notes.has(path) ? (this.notes.get(path) as string) : null;
	}
	async write(path: string, text: string): Promise<void> {
		const existed = this.notes.has(path);
		this.notes.set(path, text);
		this.emit({ type: existed ? "modify" : "create", path });
	}
	async readBinary(path: string): Promise<ArrayBuffer | null> {
		return this.blobs.get(path) ?? null;
	}
	async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
		const existed = this.blobs.has(path);
		this.blobs.set(path, content);
		this.emit({ type: existed ? "modify" : "create", path });
	}
	async remove(path: string): Promise<void> {
		this.notes.delete(path);
		this.blobs.delete(path);
		this.emit({ type: "delete", path });
	}
	async rename(from: string, to: string): Promise<void> {
		const blob = this.blobs.get(from);
		if (blob) {
			this.blobs.delete(from);
			this.blobs.set(to, blob);
		}
		const note = this.notes.get(from);
		if (note !== undefined) {
			this.notes.delete(from);
			this.notes.set(to, note);
		}
		this.emit({ type: "rename", path: to, oldPath: from });
	}
	async listNotes(): Promise<string[]> {
		return [...this.notes.keys()];
	}
	async listAttachments(): Promise<string[]> {
		return [...this.blobs.keys()];
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

/** The file routes, in memory. One per test, shared by both devices. */
class MemoryTransport implements AttachmentTransport {
	stored = new Map<string, ArrayBuffer>();
	uploads = 0;
	downloads = 0;
	limitsValue: AttachmentLimits = {
		maxAttachmentBytes: 1000,
		maxVaultBytes: 100000,
	};
	limitsFail = false;

	async upload(path: string, content: ArrayBuffer) {
		this.uploads++;
		if (content.byteLength > this.limitsValue.maxAttachmentBytes) {
			throw new Error("This file is larger than the cloud vault takes.");
		}
		this.stored.set(path, content);
		return { sha256: "", size: content.byteLength };
	}
	async download(path: string): Promise<ArrayBuffer> {
		this.downloads++;
		const found = this.stored.get(path);
		if (!found) throw new Error("No file at that path.");
		return found;
	}
	async remove(path: string): Promise<void> {
		this.stored.delete(path);
	}
	async limits(): Promise<AttachmentLimits> {
		if (this.limitsFail) throw new Error("The server did not say what it accepts.");
		return this.limitsValue;
	}
}

/** Relays tree updates between per-device docs, the way the server does. */
class Hub {
	private peers: Y.Doc[] = [];

	join(): { tree: () => TreeDoc; treeSynced: () => Promise<void> } {
		const doc = new Y.Doc();
		for (const peer of this.peers) {
			Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
		}
		doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === "remote") return;
			for (const peer of this.peers) {
				if (peer !== doc) Y.applyUpdate(peer, update, "remote");
			}
		});
		this.peers.push(doc);
		const tree = new TreeDoc(doc);
		return { tree: () => tree, treeSynced: () => Promise.resolve() };
	}
}

interface Device {
	files: MemoryFiles;
	binding: AttachmentBinding;
	refusals: { path: string; reason: string }[];
}

async function device(hub: Hub, transport: MemoryTransport): Promise<Device> {
	const files = new MemoryFiles();
	const refusals: { path: string; reason: string }[] = [];
	const binding = new AttachmentBinding(
		files,
		hub.join(),
		transport,
		(path, reason) => refusals.push({ path, reason }),
		() => "conflict 2026-08-31",
	);
	await binding.start();
	return { files, binding, refusals };
}

/** Let both bindings finish whatever the last act queued. */
async function settle(...devices: Device[]): Promise<void> {
	for (let round = 0; round < 4; round++) {
		for (const d of devices) await d.binding.flush();
	}
}

describe("an attachment travels", () => {
	it("goes up from the device that made it and down on the other one", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const alice = await device(hub, transport);
		const bob = await device(hub, transport);

		await alice.files.writeBinary("Bijlagen/foto.png", bytes("PNG bytes"));
		await settle(alice, bob);

		expect(transport.stored.has("Bijlagen/foto.png")).toBe(true);
		expect(textOf(bob.files.blobs.get("Bijlagen/foto.png") as ArrayBuffer)).toBe("PNG bytes");
		alice.binding.stop();
		bob.binding.stop();
	});

	it("does not upload the same bytes twice", async () => {
		// The echo the hash exists to kill: writeBinary on the receiving
		// device fires a create event, which pushes, which finds the hash
		// already recorded and stops. Without it two devices trade a photo
		// back and forth forever.
		const hub = new Hub();
		const transport = new MemoryTransport();
		const alice = await device(hub, transport);
		const bob = await device(hub, transport);

		await alice.files.writeBinary("foto.png", bytes("PNG bytes"));
		await settle(alice, bob);
		const after = transport.uploads;
		await settle(alice, bob);

		expect(transport.uploads).toBe(after);
		expect(after).toBe(1);
		alice.binding.stop();
		bob.binding.stop();
	});

	it("carries a file that was already on disk when the link was made", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const alice = await device(hub, transport);
		alice.binding.stop();

		// A vault somebody has been using: the file is there before anything
		// is listening, so only the link-time reconcile can find it.
		alice.files.blobs.set("oud.pdf", bytes("PDF bytes"));
		await alice.binding.start();
		await settle(alice);

		expect(transport.stored.has("oud.pdf")).toBe(true);
		alice.binding.stop();
	});

	it("leaves notes alone", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const alice = await device(hub, transport);

		await alice.files.write("Notities/plan.md", "# plan");
		await settle(alice);

		expect(transport.uploads).toBe(0);
		alice.binding.stop();
	});
});

describe("a delete and a rename", () => {
	it("takes the file off the other device too", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const alice = await device(hub, transport);
		const bob = await device(hub, transport);

		await alice.files.writeBinary("foto.png", bytes("PNG bytes"));
		await settle(alice, bob);
		await alice.files.remove("foto.png");
		await settle(alice, bob);

		expect(transport.stored.has("foto.png")).toBe(false);
		expect(bob.files.blobs.has("foto.png")).toBe(false);
		alice.binding.stop();
		bob.binding.stop();
	});

	it("moves the bytes, because the server keys an attachment by its path", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const alice = await device(hub, transport);
		const bob = await device(hub, transport);

		await alice.files.writeBinary("foto.png", bytes("PNG bytes"));
		await settle(alice, bob);
		await alice.files.rename("foto.png", "Bijlagen/foto.png");
		await settle(alice, bob);

		expect(transport.stored.has("foto.png")).toBe(false);
		expect(textOf(transport.stored.get("Bijlagen/foto.png") as ArrayBuffer)).toBe("PNG bytes");
		expect(bob.files.blobs.has("foto.png")).toBe(false);
		expect(textOf(bob.files.blobs.get("Bijlagen/foto.png") as ArrayBuffer)).toBe("PNG bytes");
		alice.binding.stop();
		bob.binding.stop();
	});
});

describe("nothing is lost", () => {
	it("keeps both copies when two devices wrote different bytes to one path", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const alice = await device(hub, transport);

		// Bob linked with a file of his own already sitting at the path the
		// cloud copy is about to claim. There is no merge for a binary, so
		// the one thing that may not happen is his copy quietly going away.
		const bob = await device(hub, transport);
		bob.binding.stop();
		bob.files.blobs.set("foto.png", bytes("bob's own photo"));

		await alice.files.writeBinary("foto.png", bytes("alice's photo"));
		await settle(alice);
		await bob.binding.start();
		await settle(alice, bob);

		expect(textOf(bob.files.blobs.get("foto.png") as ArrayBuffer)).toBe("alice's photo");
		expect(textOf(bob.files.blobs.get("foto (conflict 2026-08-31).png") as ArrayBuffer)).toBe(
			"bob's own photo",
		);
		// And the copy is not stranded on one laptop: it goes up like any
		// other attachment, so Alice gets to see what she nearly overwrote.
		expect(transport.stored.has("foto (conflict 2026-08-31).png")).toBe(true);
		alice.binding.stop();
		bob.binding.stop();
	});
});

describe("the ceilings", () => {
	it("refuses a file over the ceiling before spending the upload", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		transport.limitsValue = { maxAttachmentBytes: 10, maxVaultBytes: 100 };
		const alice = await device(hub, transport);

		await alice.files.writeBinary("video.mp4", bytes("far more than ten bytes"));
		await settle(alice);

		expect(transport.uploads).toBe(0);
		expect(alice.refusals).toHaveLength(1);
		expect(alice.refusals[0].path).toBe("video.mp4");
		expect(alice.refusals[0].reason).toContain("10 bytes");
		// Refused, not deleted: it is still the person's file.
		expect(alice.files.blobs.has("video.mp4")).toBe(true);
		alice.binding.stop();
	});

	it("takes the ceilings from the server rather than its own copy", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		transport.limitsValue = { maxAttachmentBytes: 5, maxVaultBytes: 50 };
		const alice = await device(hub, transport);

		await alice.files.writeBinary("klein.bin", bytes("123456"));
		await settle(alice);

		// Six bytes is nothing to the compiled-in fallback and too much for
		// this deployment. If the plugin were carrying its own number this
		// would have gone up.
		expect(transport.uploads).toBe(0);
		expect(FALLBACK_LIMITS.maxAttachmentBytes).toBeGreaterThan(6);
		alice.binding.stop();
	});

	it("still links when the server will not say what it accepts", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		transport.limitsFail = true;
		const alice = await device(hub, transport);

		await alice.files.writeBinary("foto.png", bytes("PNG bytes"));
		await settle(alice);

		expect(transport.stored.has("foto.png")).toBe(true);
		alice.binding.stop();
	});

	it("says what the server said when an upload comes back refused", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const alice = await device(hub, transport);
		// A ceiling the binding does not know about: the vault filling up
		// happens on the server, and this device hears about it as a throw.
		transport.limitsValue = { maxAttachmentBytes: 5, maxVaultBytes: 50 };

		await alice.files.writeBinary("foto.png", bytes("more than five"));
		await settle(alice);

		expect(alice.refusals).toHaveLength(1);
		expect(alice.refusals[0].reason).toContain("larger than the cloud vault takes");
		alice.binding.stop();
	});
});

describe("readable", () => {
	it("says a size the way a person reads one", () => {
		expect(readable(512)).toBe("512 bytes");
		expect(readable(1536)).toBe("1.5 KB");
		expect(readable(100 * 1024 * 1024)).toBe("100.0 MB");
		expect(readable(10 * 1024 * 1024 * 1024)).toBe("10.0 GB");
	});
});
