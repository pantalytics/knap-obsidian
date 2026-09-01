/**
 * A network that runs out of sockets the way a browser does, and a vault on
 * disk that lives in a Map.
 *
 * Lifted out of `__tests__/knap/socketPool.test.ts` when a second file needed
 * it: the fake is a y-protocol server, and a second hand-written copy of one
 * is a second thing that can be wrong in a way no test can see. It lives
 * under `mocks/` because jest collects everything else in `__tests__` as a
 * suite of its own.
 *
 * Real `WebsocketProvider`s talk to this over a real exchange, because what
 * the callers are about is when a socket exists, and a fake provider would
 * decide that question itself.
 */

import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";

import { KnapServer } from "../../src/knap/KnapServer";
import { KnapVaultClient } from "../../src/knap/KnapVaultClient";
import type { FileEvent, FileStore } from "../../src/knap/VaultBinding";

/** What one renderer gets. Above it Chromium queues rather than refuses. */
export const SOCKET_CEILING = 255;

export const messageSync = 0;

/**
 * The server, as far as a socket can tell: one document per room, and every
 * update relayed to the other sockets in that room.
 */
export class FakeNetwork {
	/** Sockets open right now, across every vault in this process. */
	live = 0;
	/** The most that were ever open at one instant. The claim of this file. */
	peak = 0;
	/** Sockets that asked for a connection above the ceiling and got silence. */
	refused = 0;
	/**
	 * A network that takes the connection and then says nothing, which is
	 * what a phone on a dying signal looks like from inside the plugin: the
	 * socket is there, the first sync never comes.
	 */
	deaf = false;
	/** How many times a room has been connected to, ever. */
	opens = new Map<string, number>();
	/** What the room's document held when its last socket closed. */
	closedWith = new Map<string, string>();
	docs = new Map<string, Y.Doc>();
	sockets = new Map<string, Set<FakeSocket>>();

	doc(room: string): Y.Doc {
		let doc = this.docs.get(room);
		if (!doc) {
			doc = new Y.Doc();
			doc.on("update", (update: Uint8Array, origin: unknown) => {
				for (const socket of this.sockets.get(room) ?? []) {
					if (socket !== origin) socket.deliver(update);
				}
			});
			this.docs.set(room, doc);
		}
		return doc;
	}

	text(room: string): string {
		// eslint-disable-next-line @typescript-eslint/no-base-to-string
		return this.doc(room).getText("content").toString();
	}

	/** The WebSocket implementation to hand a client. */
	get socket(): { new (url: string | URL): unknown } {
		const network = this;
		return class Bound extends FakeSocket {
			constructor(url: string | URL) {
				super(network, String(url));
			}
		};
	}
}

export class FakeSocket {
	static readonly OPEN = 1;
	readonly OPEN = 1;
	binaryType = "arraybuffer";
	readyState = 0;
	bufferedAmount = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	private readonly room: string;

	constructor(
		private readonly network: FakeNetwork,
		url: string,
	) {
		this.room = new URL(url).pathname;
		network.live += 1;
		network.peak = Math.max(network.peak, network.live);
		network.opens.set(this.room, (network.opens.get(this.room) ?? 0) + 1);
		if (network.live > SOCKET_CEILING) {
			// The bug socketPool.test.ts is about: no error, no close, no
			// handshake.
			network.refused += 1;
			return;
		}
		if (network.deaf) return;
		const room = network.sockets.get(this.room) ?? new Set<FakeSocket>();
		room.add(this);
		network.sockets.set(this.room, room);
		setTimeout(() => {
			if (this.readyState !== 0) return;
			this.readyState = 1;
			this.onopen?.();
		}, 0);
	}

	/**
	 * Send, with a buffer that drains a turn later, the way a real one does.
	 * A client that closes without waiting for it loses whatever was in it.
	 */
	send(data: Uint8Array): void {
		if (this.readyState !== 1) return;
		this.bufferedAmount += data.byteLength;
		const copy = data.slice();
		setTimeout(() => {
			this.bufferedAmount -= copy.byteLength;
			if (this.readyState !== 1) return;
			this.receive(copy);
		}, 0);
	}

	private receive(data: Uint8Array): void {
		const decoder = decoding.createDecoder(data);
		const encoder = encoding.createEncoder();
		if (decoding.readVarUint(decoder) !== messageSync) return; // awareness
		encoding.writeVarUint(encoder, messageSync);
		syncProtocol.readSyncMessage(decoder, encoder, this.network.doc(this.room), this);
		if (encoding.length(encoder) > 1) this.deliver(encoding.toUint8Array(encoder), true);
	}

	/** A message from the server. `framed` says it is already a sync message. */
	deliver(payload: Uint8Array, framed = false): void {
		let message = payload;
		if (!framed) {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageSync);
			syncProtocol.writeUpdate(encoder, payload);
			message = encoding.toUint8Array(encoder);
		}
		const bytes = message.slice();
		setTimeout(() => {
			if (this.readyState !== 1) return;
			this.onmessage?.({
				data: bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				) as ArrayBuffer,
			});
		}, 0);
	}

	close(): void {
		if (this.readyState === 3) return;
		const wasOpen = this.readyState === 1;
		this.readyState = 3;
		this.network.live -= 1;
		this.network.sockets.get(this.room)?.delete(this);
		if (wasOpen) this.network.closedWith.set(this.room, this.network.text(this.room));
		this.onclose?.({});
	}
}

/** The note half of a vault on disk, in memory. */
export class MemoryFiles implements FileStore {
	map = new Map<string, string>();

	async read(path: string): Promise<string | null> {
		return this.map.has(path) ? (this.map.get(path) as string) : null;
	}
	async write(path: string, text: string): Promise<void> {
		this.map.set(path, text);
	}
	async remove(path: string): Promise<void> {
		this.map.delete(path);
	}
	async rename(from: string, to: string): Promise<void> {
		this.map.set(to, this.map.get(from) ?? "");
		this.map.delete(from);
	}
	async readBinary(): Promise<ArrayBuffer | null> {
		return null;
	}
	async writeBinary(): Promise<void> {
		throw new Error("This store holds notes.");
	}
	async listNotes(): Promise<string[]> {
		return [...this.map.keys()].filter((path) => path.endsWith(".md"));
	}
	async listAttachments(): Promise<string[]> {
		return [];
	}
	onChange(_callback: (event: FileEvent) => void): () => void {
		return () => undefined;
	}
}

export function clientFor(network: FakeNetwork, vaultId: string): KnapVaultClient {
	const server = new KnapServer("https://knap.test", async () => new Response("{}"));
	return new KnapVaultClient(server, vaultId, "knap_token", "Laptop", network.socket);
}

export function vaultOf(count: number, prefix = "Notes"): MemoryFiles {
	const files = new MemoryFiles();
	for (let index = 0; index < count; index++) {
		files.map.set(`${prefix}/note-${index}.md`, `# Note ${index}\n`);
	}
	return files;
}

/** The room a document lives in, as the fake network keys it. */
export const roomOf = (vaultId: string, docId: string) => `/sync/${vaultId}/${docId}`;
