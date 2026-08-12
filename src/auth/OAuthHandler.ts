/**
 * OAuth Handler
 *
 * Orchestrates the OAuth flow for relay-onprem authentication: opens the
 * browser, waits for the deep link back, and turns it into a session.
 *
 * Two parameters carry the whole design, and swapping them is what made an
 * IdP with exact redirect matching work at all:
 *
 *   redirect_uri  the control plane's own https callback -- the only URI the
 *                 IdP ever sees, and one it already has registered
 *   return_url    obsidian://synced-vaults/oauth-callback -- where the control
 *                 plane sends the finished session afterwards
 *
 * The other way round, the custom scheme reached the IdP and was refused. So
 * the token exchange happens on the control plane rather than here, and what
 * this file waits for is a session, not an authorization code.
 *
 * The plugin is not an OAuth client at the identity provider and holds no
 * secret of its own; the control plane is the only client (ADR-0030).
 */

import { curryLog } from "../debug";
import { customFetch } from "../customFetch";
import {
	oauthDeepLinkReceiver,
	OAUTH_RETURN_URL,
} from "./OAuthDeepLinkReceiver";
import type { AuthResponse } from "./IAuthProvider";

interface OAuthAuthorizeApiResponse {
	authorize_url: string;
	state: string;
}

const log = curryLog("[OAuthHandler]");

export interface OAuthStartResult {
	authorizeUrl: string;
	returnUrl: string;
}

export class OAuthHandler {
	private normalizedUrl: string;
	/** The state token the control plane issued for the flow in flight. Anything on the
	 *  machine can invoke a URL scheme, so a callback carrying a different state is
	 *  rejected rather than used (session fixation, TR-21). */
	private expectedState: string | null = null;

	constructor(
		controlPlaneUrl: string,
		private serverId: string,
	) {
		// Normalize URL - remove trailing slashes to prevent double-slash issues
		this.normalizedUrl = controlPlaneUrl.replace(/\/+$/, "");
	}

	/**
	 * Start OAuth flow - registers the return URL and returns the authorize URL
	 * @param provider - OAuth provider name (e.g., "zitadel", "google", "github")
	 * @returns Authorization URL and where the flow comes back
	 */
	async prepareOAuthFlow(provider: string): Promise<OAuthStartResult> {
		log(`Preparing OAuth flow for provider: ${provider}`);

		// The IdP is told to come back to the control plane, which is the only
		// URI it has registered. Where WE want the flow to end up is the
		// return_url, which the control plane keeps to itself.
		const redirectUri = `${this.normalizedUrl}/v1/auth/oauth/${provider}/callback`;
		const returnUrl = OAUTH_RETURN_URL;

		log(`Awaiting the sign-in on ${returnUrl}`);

		// Get authorize URL from control plane
		const authorizeUrlEndpoint =
			`${this.normalizedUrl}/v1/auth/oauth/${provider}/authorize` +
			`?redirect_uri=${encodeURIComponent(redirectUri)}` +
			`&return_url=${encodeURIComponent(returnUrl)}`;

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
				this.cancelFlow();
				throw new Error(`Failed to get authorize URL: ${response.status} ${errorText}`);
			}

			const data = await response.json() as OAuthAuthorizeApiResponse;
			const authorizeUrl = data.authorize_url;

			if (!authorizeUrl) {
				this.cancelFlow();
				throw new Error("No authorize URL returned from control plane");
			}

			if (!data.state) {
				this.cancelFlow();
				throw new Error("No state token returned from control plane");
			}

			this.expectedState = data.state;

			log(`Got authorize URL: ${authorizeUrl}`);

			return {
				authorizeUrl,
				returnUrl,
			};
		} catch (error: unknown) {
			this.cancelFlow();
			throw error;
		}
	}

	/**
	 * Wait for the control plane to hand the finished session back
	 * @param provider - OAuth provider name
	 * @param timeoutMs - Maximum time to wait for the deep link (default 5 minutes)
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
			log("Waiting for the sign-in to come back...");

			// The control plane has already exchanged the code by now, so what
			// arrives is a session. Anything not carrying the state token we
			// were issued for this flow is rejected (TR-21).
			const session = await oauthDeepLinkReceiver.waitForCallback(
				this.expectedState,
				timeoutMs,
			);

			log(`Signed in with ${provider}`);

			const authResponse: AuthResponse = {
				user: {
					id: session.userId ?? "",
					email: session.userEmail ?? "",
					name: session.userName || (session.userEmail ?? ""),
					picture: undefined, // The callback carries no picture
				},
				token: {
					token: session.accessToken,
					expiresAt: Date.now() + (session.expiresIn ?? 3600) * 1000,
				},
				refreshToken: session.refreshToken,
			};

			return authResponse;
		} finally {
			// Always drop the pending flow
			this.cancelFlow();
		}
	}

	/**
	 * The whole flow: prepare, open the browser, wait for the deep link, exchange
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
	 * Stop waiting for a deep link and forget the state token
	 */
	private cancelFlow(): void {
		oauthDeepLinkReceiver.cancel();
		this.expectedState = null;
	}

	/**
	 * Cleanup
	 */
	destroy(): void {
		this.cancelFlow();
	}
}
