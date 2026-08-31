/**
 * The Knap server, as the plugin speaks to it (ADR-0073, the rebuild).
 *
 * One server, known at build time (ADR-0033), and one credential: the token
 * the sign-in flow minted. Five conversations, and nothing else:
 *
 * - the sign-in exchange: a one-time code in, the plugin's token out
 * - the sign-out: the token handed back, so it stops opening anything
 * - which cloud vaults this account may open, and what it may do there
 * - the address of a document's sync socket
 * - attachments, up and down, as plain bytes
 *
 * There is no per-document token, no rate-limited token route and no
 * control plane behind this: the server that answers is the server that
 * holds the documents, and the whole authorisation story happened when the
 * socket or the request presented the one token.
 *
 * `fetch` is injected so tests hand in a fake and Obsidian hands in its
 * own; the module never touches a global.
 */

export interface CloudVault {
	id: string;
	name: string;

}

/** The slice of a fetch Response this module reads. requestUrl adapts to it too. */
export interface HttpAnswer {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	arrayBuffer(): Promise<ArrayBuffer>;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<HttpAnswer>;

export class KnapServerError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
	}
}

export class KnapServer {
	constructor(
		private readonly baseUrl: string,
		private readonly fetchFn: Fetch,
	) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	/** Where the sign-in starts: the page the plugin opens in a browser. */
	signInUrl(): string {
		return `${this.baseUrl}/auth/plugin/start`;
	}

	/** Trade the deep link's one-time code for this device's own token. */
	async exchange(code: string, device: string): Promise<string> {
		const response = await this.fetchFn(`${this.baseUrl}/auth/plugin/exchange`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code, device }),
		});
		if (!response.ok) {
			throw new KnapServerError(
				"This sign-in code was already used or has expired. Sign in again.",
				response.status,
			);
		}
		const body = (await response.json()) as { token?: string };
		if (!body.token) {
			throw new KnapServerError("The server answered without a token.", response.status);
		}
		return body.token;
	}

	/**
	 * Hand the token back. Signing out that only forgot it here would leave a
	 * working credential behind on a laptop somebody is passing on, which is
	 * the one moment a person presses this.
	 *
	 * A 401 is the outcome, not a failure: the token is already gone, which
	 * is what sign out is for. Anything else throws, so the screen can say
	 * that the token may still be live rather than claim it is not.
	 */
	async signOut(token: string): Promise<void> {
		const response = await this.fetchFn(`${this.baseUrl}/auth/plugin/signout`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok && response.status !== 401) {
			throw new KnapServerError("The sign-out did not land.", response.status);
		}
	}

	/** The cloud vaults this account may open. */
	async listVaults(token: string): Promise<CloudVault[]> {
		const response = await this.fetchFn(`${this.baseUrl}/api/vaults`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (response.status === 401) {
			throw new KnapServerError("Not signed in any more. Sign in again.", 401);
		}
		if (!response.ok) {
			throw new KnapServerError("The server did not answer.", response.status);
		}
		const body = (await response.json()) as {
			vaults: { id: string; name: string }[];
		};
		return body.vaults.map((v) => ({ id: v.id, name: v.name }));
	}

	/**
	 * The socket base for one vault. y-websocket appends `/{docId}` itself,
	 * so the room name is the document id and nothing else.
	 */
	syncUrl(vaultId: string): string {
		return `${this.baseUrl.replace(/^http/, "ws")}/sync/${encodeURIComponent(vaultId)}`;
	}

	// -- attachments -------------------------------------------------------

	async uploadFile(
		token: string,
		vaultId: string,
		path: string,
		content: ArrayBuffer,
	): Promise<{ sha256: string; size: number }> {
		const response = await this.fetchFn(this.fileUrl(vaultId, path), {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}` },
			body: content,
		});
		if (!response.ok) {
			throw new KnapServerError("The upload did not land.", response.status);
		}
		return (await response.json()) as { sha256: string; size: number };
	}

	async downloadFile(token: string, vaultId: string, path: string): Promise<ArrayBuffer> {
		const response = await this.fetchFn(this.fileUrl(vaultId, path), {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok) {
			throw new KnapServerError("No file at that path.", response.status);
		}
		return await response.arrayBuffer();
	}

	async deleteFile(token: string, vaultId: string, path: string): Promise<void> {
		const response = await this.fetchFn(this.fileUrl(vaultId, path), {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!response.ok && response.status !== 404) {
			throw new KnapServerError("The delete did not land.", response.status);
		}
	}

	private fileUrl(vaultId: string, path: string): string {
		const encoded = path.split("/").map(encodeURIComponent).join("/");
		return `${this.baseUrl}/files/${encodeURIComponent(vaultId)}/${encoded}`;
	}
}
