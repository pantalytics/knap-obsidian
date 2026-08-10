/**
 * Signing in to Knap, which is the whole of setup.
 *
 * Four things used to happen here and a person did all of them by hand: add a
 * server by pasting a URL (with no trailing slash, which was its own support
 * conversation), log in with an email and a code copied off a web page, open
 * the Shares screen, and connect a share to a folder. This module does all
 * four from one button.
 *
 * The order is not interchangeable and each step is a precondition of the
 * next:
 *
 * 1. **Collect a credential.** The browser goes to Knap, Zitadel signs the
 *    person in, and the deep link comes back with a token we spend for the
 *    control plane's URL, an email and a code. Nobody sees any of the three.
 * 2. **Point at the server Knap named.** The plugin already ships pointing at
 *    one, so this usually changes nothing. It matters for a second
 *    deployment, and it means the URL is never typed.
 * 3. **Log in to the control plane.** Ordinary email and code, the path that
 *    already worked. What changed is where the code came from.
 * 4. **Share the vault.** One share, whole vault, because a person who has
 *    just asked for their notes to be readable has already answered the
 *    question a folder picker would ask.
 *
 * Steps 2 to 4 are skipped when they are already done, so pressing Sign in
 * twice is safe and so is pressing it on a second device.
 */

import { Notice, requestUrl } from "obsidian";
import type { Vault } from "obsidian";

import { curryLog } from "../debug";
import type { LoginManager } from "../LoginManager";
import type { RelayOnPremShareClientManager } from "../RelayOnPremShareClientManager";
import type { SharedFolders } from "../SharedFolder";
import {
	EVC_SERVER_ID,
	type RelayOnPremServer,
	type RelayOnPremSettings,
} from "../RelayOnPremConfig";
import { challengeFor, handoffReceiver, newVerifier } from "./handoff";

const log = curryLog("[KnapSignIn]", "log");

/**
 * Where the plugin sends somebody to sign in.
 *
 * Knap's own hostname, not the control plane's. That is the change this
 * module exists for: the person authenticates against the thing that holds
 * their Zitadel session, and the relay credential travels between the two
 * servers rather than through a human.
 */
export const DEFAULT_KNAP_URL = "https://knap.pantalytics.com";

interface ClaimedCredential {
	control_plane_url: string;
	email: string;
	password: string;
}

export interface SignInDeps {
	vault: Vault;
	loginManager: LoginManager;
	sharedFolders: SharedFolders;
	shareClients: RelayOnPremShareClientManager;
	settings: RelayOnPremSettings;
	/** Persist a change to the server list. */
	saveServers: (
		update: (current: RelayOnPremSettings) => RelayOnPremSettings,
	) => Promise<void>;
	/** Knap's base URL. Overridable so a test deployment can be reached. */
	knapUrl?: string;
	/** Opens the system browser. Injected so tests do not need a window. */
	openBrowser?: (url: string) => void;
}

export interface SignInResult {
	email: string;
	controlPlaneUrl: string;
	/** True when this run created the vault share rather than finding one. */
	sharedVault: boolean;
}

function normalise(url: string): string {
	return url.replace(/\/+$/, "");
}

function defaultOpenBrowser(url: string): void {
	if (typeof window !== "undefined" && window.open) {
		window.open(url, "_blank");
	}
}

/**
 * The browser half: send somebody to Knap and come back with a token.
 *
 * The handler is registered at plugin load rather than here, because the
 * browser can take long enough that Obsidian has been restarted in between.
 */
async function collect(
	knapUrl: string,
	openBrowser: (url: string) => void,
): Promise<ClaimedCredential> {
	const verifier = newVerifier();
	const challenge = await challengeFor(verifier);
	const state = newVerifier();

	// Registered before the browser opens. A fast redirect can beat a
	// listener that is set up afterwards, and that race is unreproducible
	// once it bites.
	const waiting = handoffReceiver.waitForCallback(state);

	const params = new URLSearchParams({ challenge, state });
	openBrowser(`${knapUrl}/pair/plugin/start?${params.toString()}`);

	const { token } = await waiting;

	// The verifier leaves this process for the first and only time here, over
	// HTTPS to Knap. It never goes near the browser, which is what makes the
	// token in the deep link worthless to anything that read it.
	const response = await requestUrl({
		url: `${knapUrl}/pair/plugin/claim`,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token, verifier }),
		throw: false,
	});

	if (response.status !== 200) {
		const reason =
			(response.json as { error?: string } | undefined)?.error ??
			`Knap answered ${response.status}`;
		throw new Error(reason);
	}

	return response.json as ClaimedCredential;
}

/**
 * Make sure a server row points where Knap said, and return its id.
 *
 * Knap is authoritative about its own control plane, so a disagreement is
 * resolved in its favour rather than reported. The person did not type either
 * value and has nothing to correct.
 */
async function pointAtServer(
	deps: SignInDeps,
	controlPlaneUrl: string,
): Promise<string> {
	const servers = deps.settings.servers ?? [];
	const match = servers.find(
		(s) => normalise(s.controlPlaneUrl) === normalise(controlPlaneUrl),
	);
	if (match) return match.id;

	const existing = servers.find((s) => s.id === EVC_SERVER_ID);
	const server: RelayOnPremServer = {
		id: EVC_SERVER_ID,
		name: existing?.name ?? "Knap Sync",
		controlPlaneUrl: normalise(controlPlaneUrl),
		isValidated: false,
	};

	await deps.saveServers((current) => ({
		...current,
		servers: [
			...(current.servers ?? []).filter((s) => s.id !== EVC_SERVER_ID),
			server,
		],
		defaultServerId: current.defaultServerId ?? EVC_SERVER_ID,
	}));
	deps.loginManager.addServer(server);
	return server.id;
}

/**
 * Share the whole vault, unless something is already shared.
 *
 * The guard is "any share at all", not "a vault share". Somebody who has
 * already shared one folder made a narrower choice on purpose, and widening
 * it to the whole vault behind their back is the kind of thing this flow must
 * never do. Sign in again after sharing a folder and nothing happens here.
 */
async function shareTheVault(deps: SignInDeps, serverId: string): Promise<boolean> {
	if (deps.sharedFolders.items().length > 0) {
		log("something is already shared, leaving it alone");
		return false;
	}

	const client = deps.shareClients.getClient(serverId);
	if (!client) {
		throw new Error(
			"Signed in, but Obsidian is not ready to share yet. Give it a moment " +
				"and press Sign in again.",
		);
	}

	const remote = await client.listShares();
	if (remote.length > 0) {
		log("the account already has shares, leaving them alone");
		return false;
	}

	// The vault's own name, because the control plane stores a label and an
	// empty one is unreadable in its UI. Locally the share is vault-scoped and
	// carries no prefix at all, which is what `scope` below decides.
	const share = await client.createShare({
		kind: "folder",
		path: deps.vault.getName(),
		visibility: "private",
	});

	const folder = deps.sharedFolders.new("", share.id, "relay-onprem", false, "vault");
	if (folder?.settings) {
		folder.settings.onpremServerId = serverId;
	}
	return true;
}

/**
 * The whole flow. Throws with a sentence somebody can act on.
 */
export async function signIn(deps: SignInDeps): Promise<SignInResult> {
	const knapUrl = normalise(deps.knapUrl ?? DEFAULT_KNAP_URL);
	const openBrowser = deps.openBrowser ?? defaultOpenBrowser;

	const credential = await collect(knapUrl, openBrowser);
	const serverId = await pointAtServer(deps, credential.control_plane_url);

	const ok = await deps.loginManager.loginToServer(
		serverId,
		credential.email,
		credential.password,
	);
	if (!ok) {
		throw new Error("Knap sent a credential your relay would not accept.");
	}

	const sharedVault = await shareTheVault(deps, serverId);
	return {
		email: credential.email,
		controlPlaneUrl: credential.control_plane_url,
		sharedVault,
	};
}

/**
 * `signIn` with the reporting a button needs around it.
 *
 * Kept separate so the flow above stays testable without a UI, and so the one
 * place that decides what a person is told is one place.
 */
export async function signInWithNotices(deps: SignInDeps): Promise<boolean> {
	new Notice("Your browser is open. Finish signing in there.");
	try {
		const result = await signIn(deps);
		new Notice(
			result.sharedVault
				? `Signed in as ${result.email}. Your vault is syncing.`
				: `Signed in as ${result.email}.`,
		);
		return true;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		log("sign-in failed:", error);
		new Notice(`Sign-in failed. ${message}`);
		return false;
	}
}
