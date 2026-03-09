/**
 * Relay On-Premise Token Provider
 *
 * This provider fetches relay access tokens from the relay-onprem control plane.
 * It replaces the System 3 /token endpoint with relay-onprem /tokens/relay endpoint.
 */

import { customFetch } from "../customFetch";
import { curryLog } from "../debug";
import type { ClientToken } from "../client/types";
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
	private timer: ReturnType<typeof setTimeout> | null = null;
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

		this.timer = setTimeout(() => {
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
			clearTimeout(this.timer);
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
	/** Shared throttle — all token requests for this provider share one queue */
	private throttle: TokenRequestThrottle;

	constructor(private config: RelayOnPremTokenConfig) {
		// Normalize URL - remove trailing slashes to prevent double-slash issues
		this.normalizedUrl = config.controlPlaneUrl.replace(/\/+$/, "");
		// 25 req/min leaves a 5-req safety margin below the server's 30 req/min limit
		this.throttle = new TokenRequestThrottle(25);
	}

	/**
	 * Request a relay token for document access.
	 * Requests are throttled to ≤25/min and throw RateLimitError on HTTP 429.
	 */
	async requestToken(
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
			const response = await customFetch(
				`${this.normalizedUrl}/tokens/relay`,
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

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Token request failed: ${response.status} - ${errorText}`);
			}

			const data: RelayTokenResponse = await response.json();

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
	 * Request a file token for attachment access
	 * Note: relay-onprem may need a separate endpoint for this
	 */
	async requestFileToken(
		relayId: string,
		folderId: string,
		fileId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
		filePath?: string
	): Promise<ClientToken> {
		// For now, use the same endpoint as document tokens
		// TODO: Implement separate file token endpoint if needed
		return this.requestToken(relayId, folderId, fileId, "read", filePath);
	}

	destroy() {
		this.throttle.destroy();
	}
}
