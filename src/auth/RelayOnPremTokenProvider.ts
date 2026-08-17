/**
 * Relay On-Premise Token Provider
 *
 * This provider fetches relay access tokens from the relay-onprem control plane.
 * It replaces the System 3 /token endpoint with relay-onprem /tokens/relay endpoint.
 */

import { customFetch } from "../customFetch";
import { curryLog } from "../debug";
import type { ClientToken, FileToken } from "../client/types";
import type { IAuthProvider } from "./IAuthProvider";

export interface RelayTokenRequest {
	share_id: string;
	doc_id: string;
	mode: "read" | "write";
	password?: string;
	file_path?: string; // For folder shares: path of file within folder
}

export interface RelayTokenResponse {
	relay_url: string;
	token: string;
	expires_at: string;
}

/**
 * The batch route's answer: N ordinary tokens, in the order they were asked
 * for. Each carries its own expiry rather than the batch carrying one, and
 * there is no wider token in here -- the relay server enforces one document
 * per token.
 */
export interface RelayTokenBatchResponse {
	relay_url: string;
	tokens: Array<{ doc_id: string; token: string; expires_at: string }>;
}

/**
 * Documents one batch request may ask for. The control plane's own ceiling
 * (`RELAY_TOKEN_BATCH_MAX`), and it refuses more rather than trimming, so the
 * number lives on both sides.
 *
 * It is set against the five-minute token lifetime rather than server load:
 * every token in a batch starts expiring the moment it is signed, so asking
 * for more than can be spent inside that window is signatures thrown away.
 */
export const MAX_BATCH_DOCS = 100;

interface TokenWaiter {
	resolve: (token: ClientToken) => void;
	reject: (err: Error) => void;
}

/**
 * The batch forming for one share and mode: which documents are wanted, and
 * who is waiting for each. A document asked for twice before the request goes
 * out has two waiters and still costs one token.
 */
interface PendingBatch {
	waiters: Map<string, TokenWaiter[]>;
}

export interface FileTokenRequest {
	path: string;
	sha256: string;
	content_type: string;
	content_length: number;
}

export interface FileTokenApiResponse {
	token: string;
	base_url: string;
	expires_at: string;
}

export interface RelayOnPremTokenConfig {
	controlPlaneUrl: string;
	authProvider: IAuthProvider;
}

/**
 * Error thrown when the server returns HTTP 429 Too Many Requests.
 * Carries the recommended retry-after delay in milliseconds.
 */
export class RateLimitError extends Error {
	constructor(
		public readonly retryAfterMs: number,
		message?: string,
	) {
		super(message ?? `Rate limited — retry after ${retryAfterMs}ms`);
		this.name = "RateLimitError";
	}
}

/**
 * Throttle queue: ensures at most `maxPerMinute` requests are dispatched
 * per 60-second window by spacing them out.
 *
 * With the control-plane limit of 30 req/min we use 25 slots/min (2 400 ms
 * minimum spacing) to stay safely below the ceiling.
 */
class TokenRequestThrottle {
	/** Minimum delay between consecutive dispatched requests (ms) */
	private readonly minIntervalMs: number;
	/** Timestamp when the last request was dispatched */
	private lastDispatchAt = 0;
	/** Queue of pending resolvers waiting for their turn */
	private queue: Array<() => void> = [];
	private timer: number | null = null;
	private log = curryLog("[TokenRequestThrottle]", "debug");

	constructor(maxPerMinute = 25) {
		this.minIntervalMs = Math.ceil(60_000 / maxPerMinute);
	}

	/**
	 * Returns a promise that resolves when it is this caller's turn to make
	 * a network request.  Callers are served in FIFO order with at least
	 * `minIntervalMs` between each dispatch.
	 */
	acquire(): Promise<void> {
		return new Promise((resolve) => {
			this.queue.push(resolve);
			if (this.queue.length === 1) {
				this._scheduleNext();
			}
		});
	}

	private _scheduleNext() {
		if (this.queue.length === 0) return;

		const now = Date.now();
		const elapsed = now - this.lastDispatchAt;
		const delay = Math.max(0, this.minIntervalMs - elapsed);

		this.timer = window.setTimeout(() => {
			this.timer = null;
			const next = this.queue.shift();
			if (next) {
				this.lastDispatchAt = Date.now();
				this.log(`dispatching queued request (queue remaining: ${this.queue.length})`);
				next();
				this._scheduleNext();
			}
		}, delay);
	}

	destroy() {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		// Drain any waiters so they are not leaked
		for (const resolve of this.queue) {
			resolve();
		}
		this.queue = [];
	}
}

export class RelayOnPremTokenProvider {
	private log = curryLog("[RelayOnPremTokenProvider]");
	private normalizedUrl: string;
	/** Shared throttle — all relay (document) token requests share one queue */
	private throttle: TokenRequestThrottle;
	/**
	 * File tokens pace themselves separately. Their route carries no server
	 * rate limit (measured, ADR-0051: attachments were never in the token
	 * budget), and letting them queue behind document tokens meant a vault
	 * with many attachments spent the sync's 25 slots a minute on presigned
	 * URLs while the notes waited.
	 */
	private fileThrottle: TokenRequestThrottle;
	/** Batches forming, keyed by relay, share and mode. See `joinBatch`. */
	private batches = new Map<string, PendingBatch>();
	/**
	 * Whether the control plane serves the batch route. Assumed until one
	 * answers 404, then off for this provider's life: the plugin and the
	 * server it talks to are versioned separately, and a sync that will not
	 * start is worse than one that is slow.
	 */
	private batchSupported = true;

	constructor(private config: RelayOnPremTokenConfig) {
		// Normalize URL - remove trailing slashes to prevent double-slash issues
		this.normalizedUrl = config.controlPlaneUrl.replace(/\/+$/, "");
		// 25 req/min leaves a 5-req safety margin below the server's 30 req/min limit
		this.throttle = new TokenRequestThrottle(25);
		// 120 req/min: no server ceiling to stay under, this is our own
		// restraint so an attachment-heavy first sync is not mistaken for a
		// flood by anything in between.
		this.fileThrottle = new TokenRequestThrottle(120);
	}

	/**
	 * Repoint this provider at a new control-plane URL (TR-32) — e.g. when the
	 * user edits the default server's URL in settings. The provider is
	 * otherwise long-lived (held by LiveTokenStore for the plugin's lifetime),
	 * so without this the old URL stays baked into `normalizedUrl` until reload.
	 */
	updateControlPlaneUrl(controlPlaneUrl: string): void {
		this.config.controlPlaneUrl = controlPlaneUrl;
		this.normalizedUrl = controlPlaneUrl.replace(/\/+$/, "");
	}

	/**
	 * Request a relay token for document access.
	 *
	 * Callers waiting on the same share and mode are served by one request.
	 * The control plane allows 30 requests a minute and a token is scoped to
	 * one document, so asking one at a time put a first sync of a few thousand
	 * notes at over an hour before any of somebody's writing had moved. The
	 * throttle below is what made that visible: a caller waits ~2.4s for its
	 * slot, and everything that arrives during that wait now travels with it
	 * rather than queueing behind it.
	 *
	 * Still ≤25 requests/min, still one token per document, still a
	 * RateLimitError on HTTP 429. What changed is how many documents a request
	 * carries.
	 */
	async requestToken(
		relayId: string,
		folderId: string,
		docId: string,
		mode: "read" | "write" = "read",
		filePath?: string
	): Promise<ClientToken> {
		if (!this.batchSupported) {
			return this.requestTokenAlone(relayId, folderId, docId, mode, filePath);
		}
		return this.joinBatch(relayId, folderId, docId, mode, filePath);
	}

	/**
	 * One document, one request. What every token cost before batching, and
	 * what they cost again against a control plane without the batch route.
	 */
	private async requestTokenAlone(
		relayId: string,
		folderId: string,
		docId: string,
		mode: "read" | "write" = "read",
		filePath?: string
	): Promise<ClientToken> {
		const token = await this.config.authProvider.getValidToken();

		if (!token) {
			throw new Error("Not authenticated");
		}

		this.log(`Requesting relay token for doc ${docId} in folder ${folderId}${filePath ? ` (file: ${filePath})` : ""}`);

		const request: RelayTokenRequest = {
			share_id: folderId, // In relay-onprem, folder maps to share
			doc_id: docId,
			mode,
		};

		// Include file_path for folder shares if provided
		if (filePath) {
			request.file_path = filePath;
		}

		// Wait for our slot in the throttle queue before hitting the network
		await this.throttle.acquire();

		try {
			// The /v1 mount is the canonical one; the bare path is the relay's
			// deprecated alias (ADR-0051 rejects relying on it).
			const response = await customFetch(
				`${this.normalizedUrl}/v1/tokens/relay`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify(request),
				}
			);

			if (response.status === 429) {
				// Parse Retry-After header (seconds) if present, default 60 s
				const retryAfterSec = parseInt(response.headers.get("Retry-After") ?? "60", 10);
				const retryAfterMs = (isNaN(retryAfterSec) ? 60 : retryAfterSec) * 1000;
				const errorText = await response.text().catch(() => "");
				console.warn(
					`[DIAG][RelayOnPremTokenProvider] 429 rate limited for doc ${docId}. retryAfter=${retryAfterMs}ms body=${errorText}`
				);
				throw new RateLimitError(retryAfterMs, `Token request rate limited for doc ${docId}`);
			}

			if (response.status === 403 && mode === "write") {
				// The caller always requests "write" regardless of the member's actual
				// share role (see LiveTokenStoreRefresh.ts) — the control-plane correctly
				// 403s a viewer's write request (ensure_write_access), but without this
				// fallback that 403 propagated as a hard connection failure, leaving
				// viewer-role members unable to open onprem relay shares at all (U3).
				this.log(
					`Write access denied for doc ${docId} — retrying as read-only (viewer role)`
				);
				return this.requestTokenAlone(relayId, folderId, docId, "read", filePath);
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Token request failed: ${response.status} - ${errorText}`);
			}

			const data = await response.json() as RelayTokenResponse;

			// Convert to ClientToken format expected by the plugin
			const expiresAt = new Date(data.expires_at);
			const clientToken: ClientToken = {
				token: data.token,
				url: data.relay_url,
				docId: docId,
				folder: folderId,
				expiryTime: expiresAt.getTime(),
				authorization: mode === "write" ? "full" : "read-only",
			};

			this.log(`Successfully obtained relay token, expires at ${data.expires_at}`);

			return clientToken;
		} catch (error: unknown) {
			this.log("Token request error:", error);
			throw error;
		}
	}

	/**
	 * Wait for the batch forming for this share and mode, starting one if
	 * there is none. Resolves with this document's own token.
	 */
	private joinBatch(
		relayId: string,
		folderId: string,
		docId: string,
		mode: "read" | "write",
		filePath?: string
	): Promise<ClientToken> {
		const key = `${relayId}|${folderId}|${mode}`;
		let batch = this.batches.get(key);
		if (!batch) {
			batch = { waiters: new Map() };
			this.batches.set(key, batch);
			// Kicked off now rather than on a timer: the wait for a throttle
			// slot IS the window, so there is nothing to schedule and nothing
			// to tune. A lone caller with the slot free is sent immediately.
			void this.sendBatch(key, relayId, folderId, mode, filePath);
		}
		const pending = batch;
		return new Promise<ClientToken>((resolve, reject) => {
			const waiting = pending.waiters.get(docId);
			if (waiting) {
				// Two documents asking at once is one request and one answer.
				waiting.push({ resolve, reject });
			} else {
				pending.waiters.set(docId, [{ resolve, reject }]);
			}
		});
	}

	private async sendBatch(
		key: string,
		relayId: string,
		folderId: string,
		mode: "read" | "write",
		filePath?: string
	): Promise<void> {
		await this.throttle.acquire();

		const batch = this.batches.get(key);
		// Anything arriving from here on forms the next batch rather than
		// joining one already on the wire.
		this.batches.delete(key);
		if (!batch || batch.waiters.size === 0) return;

		let docIds = [...batch.waiters.keys()];
		if (docIds.length > MAX_BATCH_DOCS) {
			// Their route refuses more than this rather than trimming it, so
			// the overflow goes back to form the next batch. It keeps its own
			// waiters, so nobody is dropped and nobody is asked for twice.
			const overflow = docIds.slice(MAX_BATCH_DOCS);
			docIds = docIds.slice(0, MAX_BATCH_DOCS);
			const next: PendingBatch = { waiters: new Map() };
			for (const id of overflow) {
				next.waiters.set(id, batch.waiters.get(id) ?? []);
				batch.waiters.delete(id);
			}
			this.batches.set(key, next);
			void this.sendBatch(key, relayId, folderId, mode, filePath);
		}

		const settle = (fn: (waiter: TokenWaiter, docId: string) => void) => {
			for (const [docId, waiters] of batch.waiters) {
				for (const waiter of waiters) fn(waiter, docId);
			}
		};

		try {
			const auth = await this.config.authProvider.getValidToken();
			if (!auth) {
				throw new Error("Not authenticated");
			}

			this.log(
				`Requesting ${docIds.length} relay token(s) for folder ${folderId}`
			);
			const response = await customFetch(
				`${this.normalizedUrl}/v1/tokens/relay/batch`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${auth}`,
					},
					body: JSON.stringify({
						share_id: folderId,
						doc_ids: docIds,
						mode,
					}),
				}
			);

			if (response.status === 404 || response.status === 405) {
				// A control plane without the batch route. Said once, then
				// every caller goes back to one request per document: slower,
				// and the alternative is a sync that does not start at all.
				this.batchSupported = false;
				this.log(
					"Control plane has no batch token route - falling back to one request per document"
				);
				settle((waiter, docId) => {
					this.requestTokenAlone(relayId, folderId, docId, mode, filePath)
						.then(waiter.resolve)
						.catch(waiter.reject);
				});
				return;
			}

			if (response.status === 429) {
				const retryAfterSec = parseInt(
					response.headers.get("Retry-After") ?? "60",
					10
				);
				const retryAfterMs = (isNaN(retryAfterSec) ? 60 : retryAfterSec) * 1000;
				const err = new RateLimitError(
					retryAfterMs,
					`Token request rate limited for ${docIds.length} document(s)`
				);
				settle((waiter) => waiter.reject(err));
				return;
			}

			if (response.status === 403 && mode === "write") {
				// A viewer's write request, refused for the share rather than
				// for any one document -- the same fallback the single route
				// takes (U3), applied to everyone in the batch.
				this.log(
					`Write access denied for folder ${folderId} - retrying as read-only (viewer role)`
				);
				settle((waiter, docId) => {
					this.joinBatch(relayId, folderId, docId, "read", filePath)
						.then(waiter.resolve)
						.catch(waiter.reject);
				});
				return;
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`Batch token request failed: ${response.status} - ${errorText}`
				);
			}

			const data = (await response.json()) as RelayTokenBatchResponse;
			const issued = new Map(data.tokens.map((t) => [t.doc_id, t]));

			settle((waiter, docId) => {
				const item = issued.get(docId);
				if (!item) {
					// A batch that answered for some and not others is not a
					// reason to guess: this document was asked for, and is owed
					// either a token or an error.
					waiter.reject(new Error(`No relay token issued for ${docId}`));
					return;
				}
				// Each token carries its own expiry. Reading a batch-level one
				// would be undefined here, and an undefined date is a NaN
				// expiryTime, which reads as expired forever: every token would
				// be re-fetched on the next use and the caching this change
				// exists to enable would quietly do nothing.
				waiter.resolve({
					token: item.token,
					url: data.relay_url,
					docId,
					folder: folderId,
					expiryTime: new Date(item.expires_at).getTime(),
					authorization: mode === "write" ? "full" : "read-only",
				});
			});
		} catch (error: unknown) {
			this.log("Batch token request error:", error);
			settle((waiter) => waiter.reject(error as Error));
		}
	}

	/**
	 * Request a file token for attachment (CAS) access — HEAD/download-url/
	 * upload-url on POST /shares/{id}/file-token's response. Unlike
	 * requestToken (relay-token for the WebSocket doc connection), this
	 * mints a presigned-URL-flavored token: CAS.ts reads only `baseUrl` and
	 * `token` off the result and does HEAD/GET/POST against
	 * `baseUrl` (+ "/download-url" | "/upload-url"). See CAS.ts for the
	 * exact three-call contract this token is consumed by.
	 *
	 * Requests one token per operation without stating read/write intent
	 * (same call shape for verify/readFile/writeFile) — the backend
	 * independently re-checks read vs write access at each of the three
	 * consuming routes, so this mint only needs read access to succeed.
	 *
	 * Storage key is `fileId` (the S3RemoteFile UUID), not the vault path:
	 * CAS.ts's call chain (SyncFile -> getFileToken(documentId, ...)) never
	 * threads the vault-relative path down to this layer, and re-deriving it
	 * would mean changing CAS.ts's own call signature. fileId is already
	 * available (decoded from documentId one layer up in fetchFileToken),
	 * stable across renames, and unique per attachment within a share — a
	 * better storage key than a path would be anyway.
	 */
	async requestFileToken(
		relayId: string,
		folderId: string,
		fileId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileToken> {
		const token = await this.config.authProvider.getValidToken();

		if (!token) {
			throw new Error("Not authenticated");
		}

		this.log(`Requesting file token for ${fileId} in folder ${folderId}`);

		const request: FileTokenRequest = {
			path: fileId,
			sha256: fileHash,
			content_type: contentType,
			content_length: contentLength,
		};

		await this.fileThrottle.acquire();

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/v1/shares/${folderId}/file-token`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify(request),
				}
			);

			if (response.status === 429) {
				const retryAfterSec = parseInt(response.headers.get("Retry-After") ?? "60", 10);
				const retryAfterMs = (isNaN(retryAfterSec) ? 60 : retryAfterSec) * 1000;
				const errorText = await response.text().catch(() => "");
				console.warn(
					`[DIAG][RelayOnPremTokenProvider] 429 rate limited for file-token ${fileId}. retryAfter=${retryAfterMs}ms body=${errorText}`
				);
				throw new RateLimitError(
					retryAfterMs,
					`File token request rate limited for ${fileId}`
				);
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`File token request failed: ${response.status} - ${errorText}`);
			}

			const data = (await response.json()) as FileTokenApiResponse;
			const expiresAt = new Date(data.expires_at);

			const fileToken: FileToken = {
				token: data.token,
				// CAS.ts does `token.baseUrl!` then customFetch(baseUrl, ...) —
				// must be populated, `url` is unused by CAS.ts but required by
				// the ClientToken shape, reuse the same value rather than "".
				baseUrl: data.base_url,
				url: data.base_url,
				docId: fileId,
				folder: folderId,
				expiryTime: expiresAt.getTime(),
				// Not read by CAS.ts (verified) — real read/write enforcement
				// happens server-side per-route, not via this cached label.
				authorization: "full",
				contentType,
				contentLength,
				fileHash,
			};

			this.log(`Successfully obtained file token for ${fileId}, expires at ${data.expires_at}`);

			return fileToken;
		} catch (error: unknown) {
			this.log("File token request error:", error);
			throw error;
		}
	}

	destroy() {
		this.throttle.destroy();
		this.fileThrottle.destroy();
	}
}
