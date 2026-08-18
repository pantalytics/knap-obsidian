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
type WebSocketImpl = { new (url: string | URL, protocols?: string | string[]): unknown };

export class KnapVaultClient {
	private open = new Map<string, OpenDoc>();
	private treeDoc: TreeDoc | null = null;

	constructor(
		private readonly server: KnapServer,
		private readonly vaultId: string,
		private readonly token: string,
		private readonly deviceName: string,
		private readonly webSocket?: WebSocketImpl,
	) {}

	/** The vault's tree, connected. The first call opens the socket. */
	tree(): TreeDoc {
		if (!this.treeDoc) {
			this.treeDoc = new TreeDoc(this.openDoc(TREE_DOC_ID).doc);
		}
		return this.treeDoc;
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
		});
		provider.awareness.setLocalStateField("device", { name: this.deviceName });

		const synced = new Promise<void>((resolve) => {
			if (provider.synced) {
				resolve();
				return;
			}
			provider.once("synced", () => resolve());
		});

		const entry: OpenDoc = { doc, provider, synced };
		this.open.set(docId, entry);
		return entry;
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
