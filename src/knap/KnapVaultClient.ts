/**
 * One linked cloud vault, live: the tree plus a socket per open document.
 *
 * A local vault is linked to at most one cloud vault (ADR-0066), so a
 * client holds exactly one of these. It keeps the tree document connected
 * for as long as it exists, because the tree is how creates, moves and
 * deletes travel; note documents connect when opened and hang around for
 * reuse. Every socket carries the same one token, and the server does the
 * whole authorisation story at the door.
 *
 * The WebSocket implementation is injected: Obsidian hands in the
 * platform's, tests hand in `ws`. y-websocket syncs same-process docs over
 * a BroadcastChannel behind the server's back, which phase 0 caught as a
 * false pass, so it is off everywhere and the wire is the only path.
 */

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

import type { KnapServer } from "./KnapServer";
import { TREE_DOC_ID, TreeDoc } from "./TreeDoc";

export interface OpenDoc {
	doc: Y.Doc;
	provider: WebsocketProvider;
	/** Resolves once the first sync with the server has completed. */
	synced: Promise<void>;
}

/**
 * y-websocket types its WebSocketPolyfill option as the DOM's WebSocket
 * constructor; ws's client satisfies the wire but not that lib typing, so
 * the seam is typed by shape rather than by name.
 */
export type WebSocketImpl = { new (url: string | URL, protocols?: string | string[]): unknown };

/** Who are you: this credential opens nothing here any more. */
export const CLOSE_UNAUTHENTICATED = 4401;
/** Not your vault: the credential is fine, the membership has gone. */
export const CLOSE_FORBIDDEN = 4403;

export class KnapVaultClient {
	private open = new Map<string, OpenDoc>();
	private treeDoc: TreeDoc | null = null;

	private refusedWith = 0;
	/**
	 * Callers waiting for a document's first sync.
	 *
	 * Held so a refusal can release them. Measured in
	 * `two_people_one_vault/`: without this, a device taken out of a vault
	 * mid-edit hangs rather than stops. The binding's queue was waiting on a
	 * `synced` that no longer had a socket to arrive on, so the work never
	 * finished and nothing after it ever ran.
	 */
	private waiting: (() => void)[] = [];

	constructor(
		private readonly server: KnapServer,
		private readonly vaultId: string,
		private readonly token: string,
		private readonly deviceName: string,
		private readonly webSocket?: WebSocketImpl,
		private readonly onRefused?: (code: number) => void,
	) {}

	/**
	 * The close code the server refused us with, or 0 while we are welcome.
	 *
	 * Sticky on purpose. A refusal is a fact about this link rather than
	 * about this socket, and the screen asks for it long after the socket
	 * that carried it has gone.
	 */
	get refused(): number {
		return this.refusedWith;
	}

	/** The vault's tree, connected. The first call opens the socket. */
	tree(): TreeDoc {
		if (!this.treeDoc) {
			this.treeDoc = new TreeDoc(this.openDoc(TREE_DOC_ID).doc);
		}
		return this.treeDoc;
	}

	/** Resolves once the tree has had its first sync with the server. */
	treeSynced(): Promise<void> {
		return this.openDoc(TREE_DOC_ID).synced;
	}

	/**
	 * Whether this device can reach the vault right now.
	 *
	 * Read off the tree's socket rather than a flag of our own, because the
	 * tree is open for as long as the link is and y-websocket already knows.
	 * A second flag would be a second thing to keep true. Nothing open yet
	 * counts as not connected: the status is asked before start() finishes.
	 */
	get connected(): boolean {
		return this.open.get(TREE_DOC_ID)?.provider.wsconnected ?? false;
	}

	/** Whether the tree has finished its first exchange with the server. */
	get settled(): boolean {
		return this.open.get(TREE_DOC_ID)?.provider.synced ?? false;
	}

	/** A note's live document, by id. Reuses an open socket. */
	note(docId: string): OpenDoc {
		return this.openDoc(docId);
	}

	/** The note's text as the shared Text the server reads. */
	contentOf(entry: OpenDoc): Y.Text {
		return entry.doc.getText("content");
	}

	private openDoc(docId: string): OpenDoc {
		const existing = this.open.get(docId);
		if (existing) return existing;

		const doc = new Y.Doc();
		const provider = new WebsocketProvider(this.server.syncUrl(this.vaultId), docId, doc, {
			params: { token: this.token, device: this.deviceName },
			WebSocketPolyfill: this.webSocket as typeof WebSocket | undefined,
			disableBc: true,
			// A refused client opens no more sockets. Every one of them would
			// be refused too, and each is another reconnect loop against a
			// vault this device is no longer in.
			connect: !this.refusedWith,
		});
		provider.awareness.setLocalStateField("device", { name: this.deviceName });

		// A refusal, not an outage. y-websocket treats every close the same
		// and reconnects with backoff forever, which for a person who was
		// taken out of a vault is a device that goes on knocking and never
		// says so. The close code is the only thing that tells the two apart,
		// and until now nothing here read it.
		provider.on("connection-close", (event: unknown) => {
			const code = (event as { code?: number } | null)?.code ?? 0;
			if (code === CLOSE_UNAUTHENTICATED || code === CLOSE_FORBIDDEN) {
				this.refuse(code);
			}
		});

		const synced = new Promise<void>((resolve) => {
			// Refused documents resolve rather than hang. Nothing is going to
			// sync them, and a caller waiting for that would wait forever:
			// the binding's queue is serial, so one such wait stops every
			// piece of work behind it.
			if (provider.synced || this.refusedWith) {
				resolve();
				return;
			}
			provider.once("synced", () => resolve());
			this.waiting.push(resolve);
		});

		const entry: OpenDoc = { doc, provider, synced };
		this.open.set(docId, entry);
		return entry;
	}

	/**
	 * Stop knocking, and tell whoever is listening why.
	 *
	 * Every socket goes, not just the one that was refused: the refusal is
	 * about this account and this vault, so the others are about to be
	 * refused too, and each one left open is another reconnect loop. Once
	 * only, because a vault with six documents open produces six of these.
	 */
	private refuse(code: number): void {
		if (this.refusedWith) return;
		this.refusedWith = code;
		this.destroy();
		// Before the callback, so a host that reacts by stopping its bindings
		// is not waiting behind a promise this refusal has already settled.
		for (const release of this.waiting.splice(0)) release();
		this.onRefused?.(code);
	}

	/** Close one document's socket, keeping the vault linked. */
	close(docId: string): void {
		const entry = this.open.get(docId);
		if (!entry) return;
		this.open.delete(docId);
		if (this.treeDoc && docId === TREE_DOC_ID) {
			this.treeDoc = null;
		}
		entry.provider.destroy();
	}

	/** Unlink or shutdown: every socket down, nothing deleted anywhere. */
	destroy(): void {
		for (const docId of [...this.open.keys()]) {
			this.close(docId);
		}
	}
}
