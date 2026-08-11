/**
 * Receives the OAuth callback over Obsidian's own URL scheme.
 *
 * This replaces a loopback HTTP server. The server worked, and it is why the
 * plugin could not sign in against an IdP that matches redirect URIs exactly:
 * it bound port 0, so the OS picked the port, and a port that changes every
 * run cannot be registered anywhere. Zitadel matches exactly. Casdoor, which
 * upstream targets, follows RFC 8252 and ignores the port on loopback, which
 * is why the design was fine for them and not for us.
 *
 * A registered `obsidian://` handler is one fixed URI, so it registers once.
 * It also works on a phone, which the loopback server never did: it required
 * Node's `http`, refused to start outside the desktop app, and iOS would not
 * have let a plugin listen on a socket anyway.
 *
 * **The IdP never sees this URI.** Registering it there was tried and refused:
 * Zitadel stores a custom scheme on a Web app and then answers "this client's
 * redirect_uri is using a custom schema and is not allowed" at authorize time,
 * and the Native app type that would allow it cannot carry a client secret,
 * which the control plane requires of a provider. So the redirect URI is the
 * control plane's own https callback and this URI is the `return_url` it
 * forwards to afterwards. The custom scheme stays between those two.
 *
 * What arrives here is therefore a finished session rather than an
 * authorization code: the control plane has already exchanged the code by the
 * time it redirects. It hands the token over in the query string, which is
 * only acceptable because it allowlists this prefix -- see
 * `deploy/evc-patches/oauth-native-return-url.patch` in knap-mcp-admin.
 *
 * What is deliberately kept from the server it replaces: the state check. A
 * callback carrying the wrong state is rejected rather than used (TR-21).
 * Anything on the machine can invoke a URL scheme, so without that check
 * somebody else's session could be fed into our flow.
 */

import { curryLog } from "../debug";

const log = curryLog("[OAuthDeepLinkReceiver]", "log");

export interface OAuthCallbackParams {
	state: string;
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	userId?: string;
	userEmail?: string;
	userName?: string;
}

interface Pending {
	expectedState: string;
	resolve: (params: OAuthCallbackParams) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * The path half of the return URL, after `obsidian://`.
 *
 * Registered with `registerObsidianProtocolHandler` at plugin load, and sent
 * to the control plane as `return_url`, which seals it into the signed state
 * and redirects here when the flow is done. Both ends must agree, and the
 * control plane's allowlist has to carry the same prefix, so this is the one
 * place it is spelled.
 */
export const OAUTH_CALLBACK_ACTION = "knap-sync/oauth-callback";

/**
 * The full return URL. Never registered at the IdP, which refuses custom
 * schemes on a Web app -- only the control plane ever sees this string.
 */
export const OAUTH_RETURN_URL = `obsidian://${OAUTH_CALLBACK_ACTION}`;

export class OAuthDeepLinkReceiver {
	private pending: Pending | null = null;

	/**
	 * Hand a callback to whichever flow is waiting.
	 *
	 * Called from the protocol handler registered in main.ts. Returns true
	 * when the callback was consumed, so the caller can tell a stray
	 * invocation from a real one.
	 */
	handleCallback(params: Record<string, string>): boolean {
		if (!this.pending) {
			log("callback arrived with no flow waiting, ignoring");
			return false;
		}

		const {
			state,
			access_token: accessToken,
			refresh_token: refreshToken,
			expires_in: expiresIn,
			user_id: userId,
			user_email: userEmail,
			user_name: userName,
			error,
			error_description: description,
		} = params;
		const pending = this.pending;

		if (error) {
			this.settle(() =>
				pending.reject(
					new Error(`OAuth failed: ${error}${description ? `: ${description}` : ""}`),
				),
			);
			return true;
		}

		if (!accessToken || !state) {
			// An empty callback is the signature of a control plane without the
			// native-return_url patch: it put the token in a cookie this
			// application cannot read and redirected here with nothing.
			this.settle(() =>
				pending.reject(
					new Error(
						"The sign-in came back without a session. The server needs " +
							"the patch that hands a token to an application callback.",
					),
				),
			);
			return true;
		}

		// TR-21. Any process can open an obsidian:// URL, so a callback whose
		// state is not the one we issued is somebody else's, or a forgery.
		if (state !== pending.expectedState) {
			log("rejecting callback: state mismatch");
			this.settle(() =>
				pending.reject(new Error("OAuth state mismatch, refusing the callback")),
			);
			return true;
		}

		this.settle(() =>
			pending.resolve({
				state,
				accessToken,
				refreshToken: refreshToken || undefined,
				expiresIn: expiresIn ? Number(expiresIn) : undefined,
				userId: userId || undefined,
				userEmail: userEmail || undefined,
				userName: userName || undefined,
			}),
		);
		return true;
	}

	/**
	 * Wait for the callback belonging to `expectedState`.
	 *
	 * Refuses to run two flows at once rather than letting the second
	 * overwrite the first, which would leave the first waiting forever.
	 */
	waitForCallback(
		expectedState: string,
		timeoutMs: number = 300000,
	): Promise<OAuthCallbackParams> {
		if (this.pending) {
			return Promise.reject(
				new Error("An OAuth sign-in is already in progress"),
			);
		}

		return new Promise<OAuthCallbackParams>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending = null;
				reject(new Error("Timed out waiting for the sign-in to come back"));
			}, timeoutMs);

			this.pending = { expectedState, resolve, reject, timer };
		});
	}

	/** Abandon a flow in progress. Safe to call when nothing is waiting. */
	cancel(reason = "OAuth sign-in cancelled"): void {
		const pending = this.pending;
		if (!pending) return;
		this.settle(() => pending.reject(new Error(reason)));
	}

	get isWaiting(): boolean {
		return this.pending !== null;
	}

	private settle(finish: () => void): void {
		if (this.pending) {
			clearTimeout(this.pending.timer);
			this.pending = null;
		}
		finish();
	}
}

/**
 * One receiver per Obsidian instance.
 *
 * The protocol handler is registered once at plugin load, long before any
 * login flow exists, so the two have to meet somewhere. A module singleton is
 * that somewhere.
 */
export const oauthDeepLinkReceiver = new OAuthDeepLinkReceiver();
