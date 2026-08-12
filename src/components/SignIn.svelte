<script lang="ts">
	import { Notice } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import type Live from "../main";
	import {
		KNAP_SERVER_ID,
		KNAP_CONTROL_PLANE_URL,
		isServerVersionSupported,
		serverCompatMessage,
	} from "../RelayOnPremConfig";
	import { confirmDialog } from "../ui/dialogs";
	import { customFetch } from "../customFetch";
	import {
		decideVaultShare,
		planFolderCleanup,
		replaceFoldersConfirmation,
		replaceFoldersFailedLine,
		replaceFoldersLine,
		FIRST_SYNC_LINES,
		REPLACE_FOLDERS_LABEL,
		type LocalShare,
		type ShareLike,
	} from "../vaultShare";
	import { RelayOnPremShareClientManager } from "../RelayOnPremShareClientManager";
	import {
		hasSignInButton,
		syncDot,
		syncInstruction,
		syncWord,
		SIGNED_OUT,
	} from "../syncStatus";

	// One button, because there is one server and one account (ADR-0030,
	// ADR-0033). No address to type, nothing to choose, and no code to paste:
	// pressing Sign in opens a browser, and the callback comes back through
	// obsidian://synced-vaults/oauth-callback.
	//
	// There is one way in and this is it. The email and password form that used
	// to sit behind "Other ways to sign in" is gone: an account made through the
	// identity service has no password to type unless an admin sets one, so the
	// second button was a door with nothing behind it.

	export let plugin: Live;

	const dispatch = createEventDispatcher<{
		signedIn: void;
		signedOut: void;
	}>();

	const relayOnPremSettings = plugin.relayOnPremSettings;

	let settings = $relayOnPremSettings;
	$: settings = $relayOnPremSettings;
	$: server = settings.servers[0];

	// Bumped after every sign-in and sign-out: the login manager is not a
	// store, so the state below is recomputed rather than subscribed to.
	let authRefreshKey = 0;
	let signingIn = false;
	let error = "";
	// What the vault is doing, once there is an account behind it. Empty until
	// signing in has had its say about the whole vault.
	let vaultLines: readonly string[] = [];

	$: auth = getAuthStatus(authRefreshKey);

	// The word comes off the shared list rather than being written here
	// (status.py, mirrored in src/syncStatus.ts). What this side knows is
	// whether there is an account and whether anything is still moving.
	$: word = syncWord({
		signedIn: auth.isSignedIn,
		paused: vaultPaused,
		syncing: vaultSyncing,
	});
	$: dot = syncDot(word);
	$: instruction = syncInstruction(word);
	// Somebody who has signed in here before is signed OUT, which is a state
	// with its own words and its own button. Somebody who never has is simply
	// new, and gets told what the button is for instead.
	$: returning = Boolean(server?.lastUserEmail);

	// Filled in by startSyncingTheVault, and by the folder it finds or makes.
	let vaultPaused = false;
	let vaultSyncing = false;
	// How many folder shares an older build left behind, and whether the
	// clean-up that replaces them is running. Zero on every install that never
	// picked folders, which is the only shape a new one can be in.
	let leftoverFolders = 0;
	let replacing = false;

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
	// syncing whole is left alone by the decision itself.
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
	 * Sync the whole vault, without asking (ADR-0032, ADR-0042).
	 *
	 * Signing in is the moment this happens, because a person who has just
	 * signed in has not met a share yet, and there is nothing to pick: a vault
	 * is one share and that is the whole of the model.
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
			leftoverFolders = 0;
			return;
		}
		if (decision.action === "replace-folders") {
			// An older build let somebody pick folders here. They cannot sit
			// beside a vault share, so the screen offers to take them off rather
			// than doing it on its own: deleting a share takes its documents
			// with it, and a folder somebody else is a member of takes their
			// copy too.
			leftoverFolders = decision.count;
			vaultLines = [replaceFoldersLine(decision.count)];
			return;
		}

		leftoverFolders = 0;
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
			vaultSyncing = true;
			vaultPaused = folder ? folder.shouldConnect === false : false;
			vaultLines = FIRST_SYNC_LINES;
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : "Could not start syncing this vault";
		}
	}

	/** A share the server says it has never heard of is already gone. */
	function alreadyGone(e: unknown): boolean {
		return e instanceof Error && /^Failed to delete share: 404\b/.test(e.message);
	}

	/**
	 * Take the folder shares off and sync the whole vault instead.
	 *
	 * The one-way door out of a build that let somebody pick folders. It runs
	 * on a button rather than on its own, because deleting a share takes its
	 * documents with it.
	 *
	 * The server goes first and the local record second, so a refusal stops the
	 * run with the two halves still agreeing about what is shared. What was
	 * already removed stays removed and pressing the button again picks up from
	 * there.
	 */
	async function replaceFolders() {
		if (replacing) return;
		const clients = shareClients();
		if (!clients) {
			error = "Sign in first.";
			return;
		}
		error = "";

		const mine: LocalShare[] = plugin.sharedFolders
			.items()
			.map((folder) => ({ id: folder.guid, isVaultScope: folder.isVaultScope }));
		const remove = planFolderCleanup(mine);
		if (remove.length === 0) {
			await startSyncingTheVault();
			return;
		}

		const agreed = await confirmDialog(
			plugin.app,
			replaceFoldersConfirmation(remove.length),
		);
		if (!agreed) return;

		replacing = true;
		try {
			for (const id of remove) {
				try {
					await clients.deleteShare(KNAP_SERVER_ID, id);
				} catch (e: unknown) {
					if (!alreadyGone(e)) {
						error = replaceFoldersFailedLine(
							e instanceof Error ? e.message : "Knap did not answer",
						);
						return;
					}
				}
				const local = plugin.sharedFolders.find((folder) => folder.guid === id);
				if (local) {
					plugin.sharedFolders.delete(local);
				}
				leftoverFolders = Math.max(0, leftoverFolders - 1);
			}

			vaultSyncing = false;
			vaultPaused = false;
			vaultLines = [];
			await startSyncingTheVault();
			new Notice("The whole vault is syncing.");
		} finally {
			// Whatever happened, the file explorer's marks are stale: the run
			// removes shares one at a time and an abort halfway leaves some of
			// them gone.
			plugin.folderNavDecorations?.quickRefresh();
			replacing = false;
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
				// Nothing to open a browser for, and there is no second way in
				// to offer instead. Say so plainly: this is the server's side
				// of it, not something to fix on this end.
				error = "Sign-in is not available right now. Try again in a few minutes.";
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
		vaultSyncing = false;
		vaultPaused = false;
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
			<span class="knap-dot knap-dot-{dot}"></span>
			<span class="knap-account-text">
				{word}{auth.email ? ` as ${auth.email}` : ""}
			</span>
			<!-- Sign out is the only button here. Who can read this led to a
			     list of one share and the screens under it, which is a second
			     level on a screen that has one thing to say: this vault syncs,
			     as you. -->
			<div class="knap-account-actions">
				<button class="knap-btn" on:click={signOut}>Sign out</button>
			</div>
		</div>
		{#if instruction}
			<p class="knap-signin-hint">{instruction}</p>
		{/if}
		{#each vaultLines as line}
			<p class="knap-signin-hint">{line}</p>
		{/each}
		<!-- The only button on this screen about what syncs, and it is here to
		     be grown out of: it exists for vaults an older build left syncing
		     folders, and it goes the moment they are gone. -->
		{#if leftoverFolders > 0}
			<button class="knap-btn mod-cta" disabled={replacing} on:click={replaceFolders}>
				{replacing ? "Working on it" : REPLACE_FOLDERS_LABEL}
			</button>
		{/if}
	{:else}
		{#if returning}
			<div class="knap-account">
				<span class="knap-dot knap-dot-{syncDot(SIGNED_OUT)}"></span>
				<span class="knap-account-text">{SIGNED_OUT}</span>
			</div>
			<p class="knap-signin-hint">{syncInstruction(SIGNED_OUT)}</p>
		{:else}
			<p class="knap-signin-line">
				Sign in with your Knap account and this vault starts syncing.
			</p>
		{/if}
		{#if hasSignInButton(SIGNED_OUT)}
			<button class="knap-btn mod-cta" disabled={signingIn} on:click={signIn}>
				{signingIn
					? "Waiting for the browser"
					: returning
						? "Sign in again"
						: "Sign in"}
			</button>
		{/if}
		{#if signingIn}
			<p class="knap-signin-hint">
				Finish in the browser window that just opened. Obsidian picks it up from
				there.
			</p>
		{/if}
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

	/* One class per dot in the shared list, so the two screens can be held
	   side by side and compared. */
	.knap-dot-ok {
		background: var(--color-green, #28a745);
	}

	.knap-dot-working {
		background: var(--interactive-accent);
	}

	.knap-dot-wait {
		background: var(--text-faint);
	}

	.knap-dot-error {
		background: var(--text-error);
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

	.knap-form-error {
		color: var(--text-error);
		font-size: 12px;
	}
</style>
