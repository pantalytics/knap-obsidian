/**
 * OAuth Handler
 *
 * Orchestrates the OAuth flow for relay-onprem authentication.
 * Handles opening browser, callback server, and token exchange.
 */

import { curryLog } from "../debug";
import { customFetch } from "../customFetch";
import {
	oauthDeepLinkReceiver,
	OAUTH_REDIRECT_URI,
} from "./OAuthDeepLinkReceiver";
import type { AuthResponse } from "./IAuthProvider";

interface OAuthAuthorizeApiResponse {
	authorize_url: string;
	state: string;
}

interface OAuthCallbackApiResponse {
	user_id: string;
	user_email: string;
	user_name?: string;
	access_token: string;
	expires_in?: number;
	refresh_token?: string;
}

const log = curryLog("[OAuthHandler]");

export interface OAuthStartResult {
	authorizeUrl: string;
	callbackUrl: string;
}

export class OAuthHandler {
	private normalizedUrl: string;
	/** The state token issued by the control plane for the in-flight flow — verified against
	 *  the loopback callback to reject any code/state a local process didn't legitimately
	 *  receive from our own authorize request (session fixation, TR-21). */
	private expectedState: string | null = null;

	constructor(
		controlPlaneUrl: string,
		private serverId: string,
	) {
		// Normalize URL - remove trailing slashes to prevent double-slash issues
		this.normalizedUrl = controlPlaneUrl.replace(/\/+$/, "");
	}

	/**
	 * Start OAuth flow - prepares callback server and returns authorize URL
	 * @param provider - OAuth provider name (e.g., "casdoor", "google", "github")
	 * @returns Authorization URL and callback info
	 */
	async prepareOAuthFlow(provider: string): Promise<OAuthStartResult> {
		log(`Preparing OAuth flow for provider: ${provider}`);

		// One fixed redirect URI, registered once at the IdP. It used to be a
		// loopback URL on an OS-assigned port, which is why signing in against
		// an IdP that matches redirect URIs exactly was impossible.
		const callbackUrl = OAUTH_REDIRECT_URI;

		log(`Awaiting the callback on ${callbackUrl}`);

		// Get authorize URL from control plane
		const authorizeUrlEndpoint = `${this.normalizedUrl}/v1/auth/oauth/${provider}/authorize?redirect_uri=${encodeURIComponent(callbackUrl)}`;

		try {
			const response = await customFetch(authorizeUrlEndpoint, {
				method: "GET",
				headers: {
					"Accept": "application/json",
					"Content-Type": "application/json",
				},
			});

			if (!response.ok) {
				const errorText = await response.text();
				this.stopCallbackServer();
				throw new Error(`Failed to get authorize URL: ${response.status} ${errorText}`);
			}

			const data = await response.json() as OAuthAuthorizeApiResponse;
			const authorizeUrl = data.authorize_url;

			if (!authorizeUrl) {
				this.stopCallbackServer();
				throw new Error("No authorize URL returned from control plane");
			}

			if (!data.state) {
				this.stopCallbackServer();
				throw new Error("No state token returned from control plane");
			}

			this.expectedState = data.state;

			log(`Got authorize URL: ${authorizeUrl}`);

			return {
				authorizeUrl,
				callbackUrl,
			};
		} catch (error: unknown) {
			this.stopCallbackServer();
			throw error;
		}
	}

	/**
	 * Wait for OAuth callback and exchange code for tokens
	 * @param provider - OAuth provider name
	 * @param timeoutMs - Maximum time to wait for callback (default 5 minutes)
	 * @returns Authentication response with user and token
	 */
	async waitForCallbackAndExchange(
		provider: string,
		timeoutMs: number = 300000,
	): Promise<AuthResponse> {
		if (!this.expectedState) {
			throw new Error("OAuth flow not started - call prepareOAuthFlow first");
		}

		try {
			log("Waiting for OAuth callback...");

			// Wait for callback with code and state, rejecting anything that doesn't carry
			// the state token we were issued for this flow (TR-21)
			const { code, state } = await oauthDeepLinkReceiver.waitForCallback(
				this.expectedState,
				timeoutMs,
			);

			log(`Received callback with code and state`);

			// Exchange code for tokens via control plane (GET with query params)
			const callbackEndpoint = `${this.normalizedUrl}/v1/auth/oauth/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

			// replayable: false — this GET is not idempotent. It exchanges a
			// one-time authorization code for a session, so replaying it after
			// a transient network error either mints a second 30-day session or
			// fails on a code the server has already spent (#14). customFetch
			// retries GETs by default; this is the exception.
			const response = await customFetch(callbackEndpoint, {
				method: "GET",
				replayable: false,
				headers: {
					"Accept": "application/json",
				},
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`OAuth callback exchange failed: ${response.status} ${errorText}`);
			}

			const data = await response.json() as OAuthCallbackApiResponse;

			log("OAuth token exchange successful");

			// Parse response to AuthResponse format (server returns flat fields)
			const authResponse: AuthResponse = {
				user: {
					id: data.user_id,
					email: data.user_email,
					name: data.user_name ?? data.user_email,
					picture: undefined, // Server doesn't return picture in callback
				},
				token: {
					token: data.access_token,
					expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
				},
				refreshToken: data.refresh_token,
			};

			return authResponse;
		} finally {
			// Always stop the callback server
			this.stopCallbackServer();
		}
	}

	/**
	 * Complete OAuth flow - prepare, open browser, wait for callback, exchange
	 * @param provider - OAuth provider name
	 * @param openBrowser - Function to open browser (e.g., window.open)
	 * @returns Authentication response with user and token
	 */
	async completeOAuthFlow(
		provider: string,
		openBrowser: (url: string) => void,
	): Promise<AuthResponse> {
		log(`Starting complete OAuth flow for provider: ${provider}`);

		// Prepare OAuth flow
		const { authorizeUrl } = await this.prepareOAuthFlow(provider);

		// Open browser to authorize URL
		log(`Opening browser to: ${authorizeUrl}`);
		openBrowser(authorizeUrl);

		// Wait for callback and exchange
		return await this.waitForCallbackAndExchange(provider);
	}

	/**
	 * Stop the callback server if running
	 */
	private stopCallbackServer(): void {
		oauthDeepLinkReceiver.cancel();
		this.expectedState = null;
	}

	/**
	 * Cleanup - stop callback server
	 */
	destroy(): void {
		this.stopCallbackServer();
	}
}
