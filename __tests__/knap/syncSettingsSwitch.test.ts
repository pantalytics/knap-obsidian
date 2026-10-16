/**
 * The vault's Sync settings switch, set on its page in the Pantalytics panel
 * and served on /api/vaults. The plugin has none of its own: it follows the
 * vault. Off means this device's settings neither go up nor come down, and
 * the first settings pass is still owed for the day somebody turns it on.
 */

import type { ConfigStore } from "../../src/knap/ConfigBinding";
import { KnapSync, type KnapLink } from "../../src/knap/KnapSync";
import { FakeNetwork, MemoryFiles } from "../mocks/fakeNetwork";

class MemoryConfig implements ConfigStore {
	files = new Map<string, ArrayBuffer>([
		[".obsidian/appearance.json", new TextEncoder().encode('{"theme":"moonstone"}').buffer],
	]);
	async list(): Promise<string[]> {
		return [...this.files.keys()];
	}
	async read(path: string): Promise<ArrayBuffer | null> {
		return this.files.get(path) ?? null;
	}
	async write(path: string, content: ArrayBuffer): Promise<void> {
		this.files.set(path, content);
	}
	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}
	onRawChange(): () => void {
		return () => undefined;
	}
	async refreshPlugins(): Promise<void> {}
}

function server(syncSettings: boolean | "unreachable") {
	const uploads: string[] = [];
	const fetchFn = async (url: string, init?: RequestInit) => {
		if (url.endsWith("/api/me")) {
			return new Response(JSON.stringify({ subject: "s1", email: "iris@example.test" }));
		}
		if (url.endsWith("/api/vaults")) {
			if (syncSettings === "unreachable") return new Response("{}", { status: 503 });
			return new Response(
				JSON.stringify({ vaults: [{ id: "v1", name: "Work notes", syncSettings }] }),
			);
		}
		if (url.includes("/files/") && init?.method === "PUT") {
			uploads.push(decodeURIComponent(url.split("/files/v1/")[1]));
			return new Response(JSON.stringify({ sha256: "abc", size: 1 }));
		}
		return new Response(
			JSON.stringify({ max_attachment_bytes: 10_000_000, max_vault_bytes: 1_000_000_000 }),
		);
	};
	return { fetchFn, uploads };
}

async function linkWith(syncSettings: boolean | "unreachable") {
	const { fetchFn, uploads } = server(syncSettings);
	let held: KnapLink | null = { token: "knap_abc", cloudVaultId: "", cloudVaultName: "" };
	const sync = new KnapSync({
		serverUrl: "https://knap.test",
		deviceName: "Laptop",
		fetchFn,
		files: new MemoryFiles(),
		config: new MemoryConfig(),
		load: () => held,
		save: async (value) => {
			held = value;
		},
		webSocket: new FakeNetwork().socket,
	});
	await sync.link({ id: "v1", name: "Work notes" });
	sync.stop();
	return { uploads, held: () => held };
}

describe("the vault's Sync settings switch", () => {
	jest.setTimeout(30_000);
	process.setMaxListeners(0);

	it("sends this device's settings up while the vault has it on", async () => {
		const { uploads, held } = await linkWith(true);
		expect(uploads).toContain(".obsidian/appearance.json");
		expect(held()?.settingsInitialized).toBe(true);
	});

	it("leaves settings alone while the vault has it off, and owes the first pass", async () => {
		const { uploads, held } = await linkWith(false);
		expect(uploads).toEqual([]);
		// Still owed: the day it is turned on, this device adopts the vault's
		// settings rather than pushing its own over everybody's.
		expect(held()?.settingsInitialized).toBe(false);
	});

	it("reads an answer it could not get as off", async () => {
		const { uploads } = await linkWith("unreachable");
		expect(uploads).toEqual([]);
	});
});
