/**
 * The settings engine, on real Yjs docs and an in-memory config directory.
 *
 * Same shape as AttachmentBinding.test.ts and for the same reason: two devices
 * hang off one hub that relays updates the way the server does, and each has
 * its own store that fires an event for the binding's own writes, exactly like
 * Obsidian's `raw`. A third store stands in for the file routes, so "the theme
 * arrived" is a claim about a transfer rather than about a mock being called.
 *
 * Timers are faked, because the binding waits for a burst of `raw` events to
 * settle before it reads a file, and a test that slept for it would spend four
 * hundred milliseconds proving nothing.
 */

import * as Y from "yjs";

import type { ConfigStore, ConfigTransport } from "../../src/knap/ConfigBinding";
import { ConfigBinding } from "../../src/knap/ConfigBinding";
import { TreeDoc } from "../../src/knap/TreeDoc";

function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function textOf(content: ArrayBuffer): string {
	return new TextDecoder().decode(content);
}

/** Obsidian's config directory, in memory, with the whole-vault `raw` event. */
class MemoryConfig implements ConfigStore {
	files = new Map<string, ArrayBuffer>();
	listeners: ((path: string) => void)[] = [];
	rosterReloads = 0;
	/** The order writes landed in, which is what the manifest rule is about. */
	written: string[] = [];

	async list(): Promise<string[]> {
		return [...this.files.keys()];
	}
	async read(path: string): Promise<ArrayBuffer | null> {
		return this.files.get(path) ?? null;
	}
	async write(path: string, content: ArrayBuffer): Promise<void> {
		this.files.set(path, content);
		this.written.push(path);
		this.emit(path);
	}
	async remove(path: string): Promise<void> {
		this.files.delete(path);
		this.emit(path);
	}
	onRawChange(callback: (path: string) => void): () => void {
		this.listeners.push(callback);
		return () => {
			this.listeners = this.listeners.filter((one) => one !== callback);
		};
	}
	async refreshPlugins(): Promise<void> {
		this.rosterReloads += 1;
	}
	/** What Obsidian does when a person changes a setting, or a note. */
	emit(path: string): void {
		for (const listener of [...this.listeners]) listener(path);
	}
	/** A person edits a settings file by hand, or Obsidian writes one. */
	async put(path: string, text: string): Promise<void> {
		this.files.set(path, bytes(text));
		this.emit(path);
	}
}

class MemoryTransport implements ConfigTransport {
	stored = new Map<string, ArrayBuffer>();
	uploads = 0;
	failUploads = false;

	async upload(path: string, content: ArrayBuffer) {
		if (this.failUploads) throw new Error("A hidden path is not part of the vault.");
		this.uploads += 1;
		this.stored.set(path, content);
		return { sha256: "", size: content.byteLength };
	}
	async download(path: string): Promise<ArrayBuffer> {
		const found = this.stored.get(path);
		if (!found) throw new Error("No file at that path.");
		return found;
	}
	async remove(path: string): Promise<void> {
		this.stored.delete(path);
	}
}

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
	config: MemoryConfig;
	binding: ConfigBinding;
	refusals: { path: string; reason: string }[];
}

async function device(hub: Hub, transport: MemoryTransport, seed?: MemoryConfig): Promise<Device> {
	const config = seed ?? new MemoryConfig();
	const refusals: { path: string; reason: string }[] = [];
	const binding = new ConfigBinding(config, hub.join(), transport, (path, reason) =>
		refusals.push({ path, reason }),
	);
	await binding.start();
	return { config, binding, refusals };
}

/** Let the settle timer fire and the queue behind it drain. */
async function settle(...devices: Device[]): Promise<void> {
	jest.advanceTimersByTime(2000);
	for (const one of devices) await one.binding.flush();
	// The roster reload is scheduled behind its own timer, after the writes.
	jest.advanceTimersByTime(2000);
	for (const one of devices) await one.binding.flush();
}

const bindings: ConfigBinding[] = [];

beforeEach(() => {
	jest.useFakeTimers();
});

afterEach(() => {
	for (const binding of bindings.splice(0)) binding.stop();
	jest.useRealTimers();
});

function keep(...made: Device[]): void {
	for (const one of made) bindings.push(one.binding);
}

describe("two devices, one cloud vault", () => {
	it("carries a theme from the device that has one to the device that does not", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const seeded = new MemoryConfig();
		await seeded.put(".obsidian/appearance.json", '{"accentColor":"#ff0055"}');

		const laptop = await device(hub, transport, seeded);
		keep(laptop);
		await settle(laptop);

		const phone = await device(hub, transport);
		keep(phone);
		await settle(phone);

		expect(textOf(phone.config.files.get(".obsidian/appearance.json") as ArrayBuffer)).toBe(
			'{"accentColor":"#ff0055"}',
		);
	});

	it("carries a plugin, and writes its manifest last", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const seeded = new MemoryConfig();
		await seeded.put(".obsidian/plugins/dataview/manifest.json", '{"id":"dataview"}');
		await seeded.put(".obsidian/plugins/dataview/main.js", "module.exports = {};");
		await seeded.put(".obsidian/community-plugins.json", '["dataview"]');

		const laptop = await device(hub, transport, seeded);
		keep(laptop);
		await settle(laptop);

		const phone = await device(hub, transport);
		keep(phone);
		await settle(phone);

		expect([...phone.config.files.keys()].sort()).toEqual([
			".obsidian/community-plugins.json",
			".obsidian/plugins/dataview/main.js",
			".obsidian/plugins/dataview/manifest.json",
		]);
		// A folder that has its manifest before its code is a plugin that half
		// exists: Obsidian lists it and then fails to load it.
		const wrote = phone.config.written;
		expect(wrote.indexOf(".obsidian/plugins/dataview/main.js")).toBeLessThan(
			wrote.indexOf(".obsidian/plugins/dataview/manifest.json"),
		);
	});

	it("asks Obsidian to read its plugin folder again, once, after a plugin lands", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const seeded = new MemoryConfig();
		await seeded.put(".obsidian/plugins/dataview/manifest.json", "{}");
		await seeded.put(".obsidian/plugins/dataview/main.js", "x");
		await seeded.put(".obsidian/plugins/dataview/styles.css", "y");

		const laptop = await device(hub, transport, seeded);
		keep(laptop);
		await settle(laptop);

		const phone = await device(hub, transport);
		keep(phone);
		await settle(phone);

		// Obsidian does not notice a folder that appears while it is running,
		// so it is asked. Once for the three files, not three times.
		expect(phone.config.rosterReloads).toBe(1);
	});

	it("does not reload the roster for a theme", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const seeded = new MemoryConfig();
		await seeded.put(".obsidian/appearance.json", "{}");

		const laptop = await device(hub, transport, seeded);
		keep(laptop);
		await settle(laptop);

		const phone = await device(hub, transport);
		keep(phone);
		await settle(phone);
		expect(phone.config.rosterReloads).toBe(0);
	});

	it("leaves our own folder and the pane layout where they are", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const seeded = new MemoryConfig();
		await seeded.put(".obsidian/plugins/synced-vaults/data.json", '{"token":"knap_secret"}');
		await seeded.put(".obsidian/plugins/synced-vaults/knap-seen.json", "{}");
		await seeded.put(".obsidian/workspace.json", '{"panes":1}');
		await seeded.put(".obsidian/workspace-mobile.json", '{"panes":2}');
		await seeded.put(".obsidian/appearance.json", "{}");

		const laptop = await device(hub, transport, seeded);
		keep(laptop);
		await settle(laptop);

		// One file went up, and it is not the one with the token in it.
		expect([...transport.stored.keys()]).toEqual([".obsidian/appearance.json"]);

		const phone = await device(hub, transport);
		keep(phone);
		await settle(phone);
		expect(phone.config.files.has(".obsidian/plugins/synced-vaults/data.json")).toBe(false);
		expect(phone.config.files.has(".obsidian/workspace.json")).toBe(false);
	});

	it("ignores the notes, which reach the same event", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const laptop = await device(hub, transport);
		keep(laptop);

		// `raw` is a whole-vault event: every note write fires it too, and
		// the other two bindings own those.
		await laptop.config.put("Areas/Work/Acme.md", "# a note");
		await laptop.config.put(".trash/gone.md", "# deleted");
		await settle(laptop);
		expect(transport.uploads).toBe(0);
	});

	it("does not send the same file twice for one burst of events", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const laptop = await device(hub, transport);
		keep(laptop);

		// One accent colour was six `raw` events in the spike.
		for (let i = 0; i < 6; i += 1) {
			await laptop.config.put(".obsidian/appearance.json", '{"accentColor":"#00c2a8"}');
		}
		await settle(laptop);
		expect(transport.uploads).toBe(1);
	});

	it("does not echo its own write back up", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const seeded = new MemoryConfig();
		await seeded.put(".obsidian/hotkeys.json", '{"a":1}');
		const laptop = await device(hub, transport, seeded);
		keep(laptop);
		await settle(laptop);
		const after = transport.uploads;

		const phone = await device(hub, transport);
		keep(phone);
		await settle(phone, laptop);
		// The phone wrote the file, its own store fired an event, and the
		// hash already in the tree is what stops that becoming an upload.
		expect(transport.uploads).toBe(after);
	});

	it("takes the newer write, with no conflict copy left behind", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const laptop = await device(hub, transport);
		const phone = await device(hub, transport);
		keep(laptop, phone);

		await laptop.config.put(".obsidian/appearance.json", '{"accentColor":"#ff0055"}');
		await settle(laptop, phone);
		await phone.config.put(".obsidian/appearance.json", '{"accentColor":"#00c2a8"}');
		await settle(phone, laptop);

		expect(textOf(laptop.config.files.get(".obsidian/appearance.json") as ArrayBuffer)).toBe(
			'{"accentColor":"#00c2a8"}',
		);
		// No `appearance (conflict from iPhone).json`: a second copy inside a
		// folder nobody can open from Obsidian is litter, not a rescue.
		expect([...laptop.config.files.keys()]).toEqual([".obsidian/appearance.json"]);
	});

	it("a snippet deleted here leaves the cloud vault too", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const seeded = new MemoryConfig();
		await seeded.put(".obsidian/snippets/mine.css", "body{}");
		const laptop = await device(hub, transport, seeded);
		const phone = await device(hub, transport);
		keep(laptop, phone);
		await settle(laptop, phone);
		expect(phone.config.files.has(".obsidian/snippets/mine.css")).toBe(true);

		await laptop.config.remove(".obsidian/snippets/mine.css");
		await settle(laptop, phone);

		expect(transport.stored.has(".obsidian/snippets/mine.css")).toBe(false);
		expect(phone.config.files.has(".obsidian/snippets/mine.css")).toBe(false);
	});

	it("says which file could not travel, and carries on", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const laptop = await device(hub, transport);
		keep(laptop);
		transport.failUploads = true;

		await laptop.config.put(".obsidian/appearance.json", "{}");
		await settle(laptop);

		expect(laptop.refusals).toEqual([
			{ path: ".obsidian/appearance.json", reason: "A hidden path is not part of the vault." },
		]);
		// Refused, and not recorded: a tree entry with nothing behind it
		// sends every other device after bytes that are not there.
		expect(transport.stored.size).toBe(0);
	});

	it("stops listening when it is stopped", async () => {
		const hub = new Hub();
		const transport = new MemoryTransport();
		const laptop = await device(hub, transport);
		laptop.binding.stop();

		await laptop.config.put(".obsidian/appearance.json", "{}");
		jest.advanceTimersByTime(2000);
		await laptop.binding.flush();
		expect(transport.uploads).toBe(0);
	});
});
