/**
 * Collecting a relay credential from Knap over a deep link.
 *
 * The plugin used to be handed three fields on a web page and ask a person to
 * retype them: a server URL, an email, and a code. That is gone. Knap signs
 * the person in with Zitadel, mints the credential itself, and sends the
 * browser back into `obsidian://knap-sync/paired` carrying a token this
 * module spends.
 *
 * **Why a token in that URL is not enough on its own.** Anything installed on
 * the machine can register an `obsidian://` handler, and the browser writes
 * the URL to history either way. So the token is readable by a process that
 * is not us, and whoever reads it would otherwise get a working relay
 * credential.
 *
 * The fix is PKCE's, applied to the same problem. We invent a `verifier`,
 * keep it in memory, and send only its SHA-256 to Knap when the browser
 * opens. Claiming needs both, so the token alone is worthless: a thief who
 * reads the deep link cannot spend what it carries. The one thing they can do
 * is burn it, which costs the person one more press of Sign in and gains the
 * thief nothing.
 *
 * The state check is the same one `OAuthDeepLinkReceiver` makes, for the same
 * reason (TR-21), and it is kept here rather than shared because the two
 * flows carry different parameters and merging them would mean a receiver
 * that understands both.
 */

import { curryLog } from "../debug";

const log = curryLog("[KnapHandoff]", "log");

/**
 * The path half of the deep link, after `obsidian://`.
 *
 * Registered with `registerObsidianProtocolHandler` at plugin load, and known
 * to Knap as a constant rather than as a parameter it accepts. Both sides
 * spell it once: here, and in `handoff.py`'s `DEEP_LINK`. They have to agree,
 * so if this changes that one does too.
 */
export const PAIRED_ACTION = "knap-sync/paired";

/** Bytes of entropy in the verifier. Matches Knap's own token width. */
const VERIFIER_BYTES = 32;

export interface HandoffCallback {
	token: string;
	state: string;
}

interface Pending {
	expectedState: string;
	resolve: (params: HandoffCallback) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh verifier. Never leaves this process. */
export function newVerifier(): string {
	const bytes = new Uint8Array(VERIFIER_BYTES);
	crypto.getRandomValues(bytes);
	return toBase64Url(bytes);
}

/**
 * The challenge for a verifier: SHA-256, lowercase hex.
 *
 * Hex rather than base64url because it is what Knap validates against, and a
 * fixed-length hex string is the cheapest thing for it to reject on the way
 * in rather than at claim time.
 */
export async function challengeFor(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export class HandoffReceiver {
	private pending: Pending | null = null;

	/**
	 * Hand a callback to whichever flow is waiting.
	 *
	 * Returns true when the callback was consumed, so a stray invocation is
	 * distinguishable from a real one.
	 */
	handleCallback(params: Record<string, string>): boolean {
		if (!this.pending) {
			log("handoff arrived with no sign-in waiting, ignoring");
			return false;
		}

		const { token, state, error } = params;
		const pending = this.pending;

		if (error) {
			// Knap's words, not ours. It knows why it could not finish and we
			// would only be paraphrasing.
			this.settle(() => pending.reject(new Error(error)));
			return true;
		}

		if (!token || !state) {
			this.settle(() =>
				pending.reject(new Error("The sign-in came back incomplete. Try again.")),
			);
			return true;
		}

		// TR-21. Any process can open an obsidian:// URL, so a callback whose
		// state is not the one we issued is somebody else's, or a forgery.
		if (state !== pending.expectedState) {
			log("rejecting handoff: state mismatch");
			this.settle(() =>
				pending.reject(new Error("That sign-in did not belong to this one.")),
			);
			return true;
		}

		this.settle(() => pending.resolve({ token, state }));
		return true;
	}

	/**
	 * Wait for the handoff belonging to `expectedState`.
	 *
	 * Refuses to run two at once rather than letting the second overwrite the
	 * first, which would leave the first waiting until it timed out.
	 */
	waitForCallback(
		expectedState: string,
		timeoutMs: number = 300000,
	): Promise<HandoffCallback> {
		if (this.pending) {
			return Promise.reject(new Error("A sign-in is already in progress"));
		}

		return new Promise<HandoffCallback>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending = null;
				reject(new Error("Timed out waiting for the sign-in to come back"));
			}, timeoutMs);

			this.pending = { expectedState, resolve, reject, timer };
		});
	}

	/** Abandon a flow in progress. Safe to call when nothing is waiting. */
	cancel(reason = "Sign-in cancelled"): void {
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
 * The protocol handler is registered at plugin load, long before any sign-in
 * exists, so the two have to meet somewhere. A module singleton is that
 * somewhere, and it is also what lets the browser come back after a restart.
 */
export const handoffReceiver = new HandoffReceiver();
