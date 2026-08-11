<script lang="ts">
	import { Notice } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import {
		KNAP_SERVER_ID,
		KNAP_CONTROL_PLANE_URL,
		isServerVersionSupported,
		serverCompatMessage,
	} from "../RelayOnPremConfig";
	import { RelayOnPremLoginModal } from "../ui/RelayOnPremLoginModal";
	import { customFetch } from "../customFetch";
	import {
		decideVaultShare,
		foldersInsteadLine,
		FIRST_SYNC_LINES,
		type ShareLike,
	} from "../vaultShare";
	import { RelayOnPremShareClientManager } from "../RelayOnPremShareClientManager";

	// One button, because there is one server and one account (ADR-0030,
	// ADR-0033). No address to type, nothing to choose, and no code to paste:
	// pressing Sign in opens a browser, and the callback comes back through
	// obsidian://knap-sync/oauth-callback.
	//
	// Email and password are still here, behind Other ways to sign in, for the
	// day the identity service is unreachable. They are not what a new person
	// is shown.

	export let plugin: Live;

	const dispatch = createEventDispatcher<{
		signedIn: void;
		signedOut: void;
		openShares: { server: RelayOnPremServer };
	}>();

	const relayOnPremSettings = plugin.relayOnPremSettings;

	let settings = $relayOnPremSettings;
	$: settings = $relayOnPremSettings;
	$: server = settings.servers[0];

	// Bumped after every sign-in and sign-out: the login manager is not a
	// store, so the state below is recomputed rather than subscribed to.
	let authRefreshKey = 0;
	let signingIn = false;
	let showOtherWays = false;
	let error = "";
	// What the vault is doing, once there is an account behind it. Empty until
	// signing in has had its say about the whole vault.
	let vaultLines: readonly string[] = [];

	$: auth = getAuthStatus(authRefreshKey);

	function getAuthStatus(_refreshKey: number): {
		isSignedIn: boolean;
		email?: string;
	} {
		const lm = plugin.loginManager;
		if (!lm || typeof lm.isLoggedInToServer !== "function") {
			return { isSignedIn: false };
		}
		const user = lm.getMultiServerAuthManager?.()?.getUserForServer?.(KNAP_SERVER_ID);
		return { isSignedIn: lm.isLoggedInToServer(KNAP_SERVER_ID), email: user?.email };
	}

	function refresh(signedIn: boolean) {
		authRefreshKey = authRefreshKey + 1;
		dispatch(signedIn ? "signedIn" : "signedOut");
		if (signedIn) {
			void startSyncingTheVault();
		} else {
			vaultLines = [];
		}
	}

	// Signing in is the consent (ADR-0032), and this covers the person who
	// signed in on an older build and has nothing shared yet: they are looking
	// at this screen while it happens, with the copy under it. Somebody already
	// syncing, whole or by folders, is left alone by the decision itself.
	onMount(() => {
		if (getAuthStatus(0).isSignedIn) {
			void startSyncingTheVault();
		}
	});

	/** The share clients, which only exist once somebody is signed in. */
	function shareClients(): RelayOnPremShareClientManager | undefined {
		if (!plugin.shareClientManager) {
			const multiServerAuth = plugin.loginManager.getMultiServerAuthManager();
			if (!multiServerAuth) return undefined;
			plugin.shareClientManager = new RelayOnPremShareClientManager(
				multiServerAuth,
				settings.servers,
			);
		}
		for (const s of settings.servers) {
			if (!plugin.shareClientManager.getClient(s.id)) {
				plugin.shareClientManager.addServer(s);
			}
		}
		return plugin.shareClientManager;
	}

	/**
	 * Sync the whole vault, without asking (ADR-0032).
	 *
	 * Signing in is the moment this happens, because a person who has just
	 * signed in has not met a share or a folder picker yet, and asking them to
	 * pick one is asking about a vault they have not seen us handle.
	 */
	async function startSyncingTheVault() {
		const clients = shareClients();
		if (!clients) return;

		const vaultName = plugin.app.vault.getName();
		const folders = plugin.sharedFolders.items();
		const local = {
			hasVaultShare: folders.some((folder) => folder.isVaultScope),
			folderShareCount: folders.filter((folder) => !folder.isVaultScope).length,
		};

		let remote: ShareLike[] = [];
		try {
			remote = (await clients.listShares(KNAP_SERVER_ID)) as ShareLike[];
		} catch (e: unknown) {
			// Listing is how a second device finds the share it should adopt.
			// Without it, creating one would risk a duplicate of the same
			// vault, so say nothing happened rather than guess.
			error = e instanceof Error ? e.message : "Could not reach Knap";
			return;
		}

		const decision = decideVaultShare(vaultName, remote, local);
		if (decision.action === "already-syncing") {
			return;
		}
		if (decision.action === "folders-instead") {
			vaultLines = [foldersInsteadLine(decision.count)];
			return;
		}

		try {
			const share =
				decision.action === "adopt"
					? decision.share
					: await clients.createShare(KNAP_SERVER_ID, {
							path: decision.path,
							kind: "folder",
							visibility: "private",
						});

			// The empty path is the vault root, and "vault" is the scope that
			// makes every path in the share resolve without a prefix.
			const folder = plugin.sharedFolders.new("", share.id, "relay-onprem", false, "vault");
			if (folder?.settings) {
				folder.settings.onpremServerId = KNAP_SERVER_ID;
			}
			plugin.folderNavDecorations?.quickRefresh();
			vaultLines = FIRST_SYNC_LINES;
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : "Could not start syncing this vault";
		}
	}

	interface ServerFeatures {
		oauth_enabled?: boolean;
		oauth_provider?: string | null;
	}

	interface ServerInfo {
		version?: string;
		features?: ServerFeatures;
	}

	async function fetchServerInfo(): Promise<ServerInfo | null> {
		try {
			const response = await customFetch(`${serverUrl()}/server/info`, {
				method: "GET",
			});
			if (response.ok) {
				return (await response.json()) as ServerInfo;
			}
		} catch {
			// An older server may not have the endpoint at all, and a network
			// blip looks the same from here. Either way sign-in carries on and
			// fails with its own message if it is going to.
		}
		return null;
	}

	// The address is build configuration, so the stored copy is only ever a
	// cache of it. Prefer the built-in one.
	function serverUrl(): string {
		return KNAP_CONTROL_PLANE_URL || server?.controlPlaneUrl || "";
	}

	function openPasswordSignIn() {
		error = "";
		const modal = new RelayOnPremLoginModal(
			plugin.app,
			plugin.loginManager,
			() => refresh(true),
			KNAP_SERVER_ID,
		);
		modal.open();
	}

	async function signIn() {
		error = "";
		signingIn = true;
		try {
			const info = await fetchServerInfo();

			// TR-57: a server below this plugin's floor says so here, rather
			// than failing later on an endpoint it does not have. Only a
			// version we can read and know is too old blocks: a missing one
			// means the fetch above came back empty, which is not the same
			// thing.
			if (info?.version && !isServerVersionSupported(info.version)) {
				error = serverCompatMessage(info.version);
				return;
			}

			const provider = info?.features?.oauth_enabled
				? info.features.oauth_provider
				: null;

			if (!provider) {
				// Nothing to open a browser for. Email and password are the
				// way in, so go straight there instead of failing first.
				openPasswordSignIn();
				return;
			}

			// Through the login manager rather than the auth provider, so that
			// the post-login hook in main.ts runs and shares start (TR-10).
			await plugin.loginManager.loginWithOAuth2(provider, KNAP_SERVER_ID);
			new Notice("Signed in");
			refresh(true);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : "Sign-in failed";
			error = message.includes("timeout")
				? "Sign-in timed out. Try again, and finish in the browser window that opens."
				: message;
		} finally {
			signingIn = false;
		}
	}

	async function signOut() {
		error = "";
		try {
			await plugin.loginManager.logoutFromServer(KNAP_SERVER_ID);
			new Notice("Signed out");
			refresh(false);
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : "Sign-out failed";
		}
	}
</script>

<div class="knap-signin">
	{#if auth.isSignedIn}
		<div class="knap-account">
			<span class="knap-dot is-on"></span>
			<span class="knap-account-text">
				Signed in{auth.email ? ` as ${auth.email}` : ""}
			</span>
			<div class="knap-account-actions">
				{#if server}
					<button class="knap-btn" on:click={() => dispatch("openShares", { server })}>
						Shared folders
					</button>
				{/if}
				<button class="knap-btn" on:click={signOut}>Sign out</button>
			</div>
		</div>
		{#each vaultLines as line}
			<p class="knap-signin-hint">{line}</p>
		{/each}
	{:else}
		<p class="knap-signin-line">
			Sign in with your Knap account. Then share this vault, or a folder in it.
		</p>
		<button class="knap-btn mod-cta" disabled={signingIn} on:click={signIn}>
			{signingIn ? "Waiting for the browser" : "Sign in"}
		</button>
		{#if signingIn}
			<p class="knap-signin-hint">
				Finish in the browser window that just opened. Obsidian picks it up from
				there.
			</p>
		{/if}

		<div class="knap-other">
			<button
				class="knap-link-btn"
				aria-expanded={showOtherWays}
				on:click={() => (showOtherWays = !showOtherWays)}
			>
				Other ways to sign in
			</button>
			{#if showOtherWays}
				<p class="knap-signin-hint">
					Email and password still work, for a day the sign-in page will not load.
				</p>
				<button class="knap-btn" on:click={openPasswordSignIn}>
					Use email and password
				</button>
			{/if}
		</div>
	{/if}

	{#if error}
		<div class="knap-form-error">{error}</div>
	{/if}
</div>

<style>
	.knap-signin {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
	}

	.knap-signin-line {
		margin: 0;
		color: var(--text-normal);
	}

	.knap-signin-hint {
		margin: 0;
		color: var(--text-muted);
		font-size: 12px;
		max-width: 46em;
	}

	.knap-account {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 12px 14px;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-m, 8px);
		background: var(--background-secondary);
		font-size: var(--font-ui-small, 13px);
	}

	.knap-account-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.knap-account-actions {
		margin-left: auto;
		display: flex;
		gap: 6px;
	}

	.knap-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
		flex: none;
	}

	.knap-dot.is-on {
		background: var(--color-green, #28a745);
	}

	.knap-btn {
		padding: 4px 10px;
		font-size: 12px;
		cursor: pointer;
	}

	.knap-btn:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.knap-other {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		padding-top: 4px;
	}

	.knap-link-btn {
		padding: 0;
		background: transparent;
		border: none;
		box-shadow: none;
		font-size: 12px;
		color: var(--text-muted);
		cursor: pointer;
	}

	.knap-link-btn:hover {
		background: transparent;
		color: var(--text-normal);
	}

	.knap-form-error {
		color: var(--text-error);
		font-size: 12px;
	}
</style>
