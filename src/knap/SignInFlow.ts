/**
 * The sign-in, from the plugin's side: open a browser, catch a deep link,
 * trade the code, hold a token.
 *
 * The server does the OAuth (it is the client at the issuer); what comes
 * back through `obsidian://synced-vaults/signin` is a one-time handoff
 * code, never a credential, because a deep-link URL survives in browser
 * history. The exchange for the real token happens over TLS, exactly once.
 *
 * The action string keeps the `synced-vaults` identifier: the plugin's id
 * moved once and is staying (ADR-0042), rebuild or no rebuild.
 */

import type { KnapServer } from "./KnapServer";

/** Registered with registerObsidianProtocolHandler at plugin load. */
export const SIGNIN_ACTION = "synced-vaults/signin";

/** How long a person gets to finish signing in before the flow gives up. */
const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000;

type OpenUrl = (url: string) => void;

interface Pending {
	resolve: (token: string) => void;
	reject: (error: Error) => void;
	timer: number;
}

export class SignInFlow {
	private pending: Pending | null = null;

	constructor(
		private readonly server: KnapServer,
		private readonly deviceName: string,
	) {}

	/**
	 * Start the flow: open the browser, and settle when the deep link comes
	 * back and the exchange lands. One flow at a time; a second click
	 * restarts rather than stacking.
	 */
	begin(openUrl: OpenUrl): Promise<string> {
		this.cancel(new Error("A newer sign-in replaced this one."));
		openUrl(this.server.signInUrl());
		return new Promise<string>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending = null;
				reject(new Error("The sign-in took too long. Try again."));
			}, SIGNIN_TIMEOUT_MS);
			this.pending = { resolve, reject, timer };
		});
	}

	/**
	 * The protocol handler's half. Returns true when the callback fed a
	 * waiting flow, so a stray link is telling from a real one.
	 */
	handleDeepLink(params: Record<string, string>): boolean {
		const pending = this.pending;
		if (!pending) return false;
		this.pending = null;
		window.clearTimeout(pending.timer);

		const code = params.code ?? "";
		if (!code) {
			pending.reject(new Error("The sign-in came back without a code. Try again."));
			return true;
		}
		this.server
			.exchange(code, this.deviceName)
			.then((token) => pending.resolve(token))
			.catch((error: Error) => pending.reject(error));
		return true;
	}

	cancel(reason: Error): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = null;
		window.clearTimeout(pending.timer);
		pending.reject(reason);
	}
}
