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
		syncModeFor,
		withUpdatedSyncMode,
	} from "../RelayOnPremConfig";
	import { confirmDialog } from "../ui/dialogs";
	import { customFetch } from "../customFetch";
	import {
		decideVaultShare,
		foldersInsteadLine,
		foldersToggleHint,
		planModeSwitch,
		switchConfirmation,
		switchedNotice,
		switchFailedLine,
		FIRST_SYNC_LINES,
		FOLDERS_TOGGLE_LABEL,
		type LocalShare,
		type ShareLike,
		type VaultSyncMode,
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
	// obsidian://knap-sync/oauth-callback.
	//
	// There is one way in and this is it. The email and password form that used
	// to sit behind "Other ways to sign in" is gone: an account made through the
	// identity service has no password to type unless an admin sets one, so the
	// second button was a door with nothing behind it.

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
	// What this vault syncs. A setting on this side only: the server is told
	// which folders to share and never which preference produced them.
	$: mode = syncModeFor(settings, KNAP_SERVER_ID);

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
	// True while the switch is removing shares. The toggle is disabled for the
	// duration, because a second flip halfway through would plan against a
	// list that is still being taken apart.
	let switching = false;

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
	/**
	 * `current` is passed rather than read off `mode`, and that is not a
	 * flourish. `mode` is a reactive value derived from the settings store, and
	 * a reactive statement does not run until the next flush, so the switch
	 * calling this immediately after writing the setting would read the old
	 * one. Reading "folders" here after switching to the whole vault would put
	 * the setting straight back.
	 */
	async function startSyncingTheVault(current: VaultSyncMode = mode) {
		const clients = shareClients();
		if (!clients) return;

		const vaultName = plugin.app.vault.getName();
		const folders = plugin.sharedFolders.items();
		const local = {
			mode: current,
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
			// A second device arrives here: the folders came off the server and
			// the setting is per device, so what is shared is where the mode is
			// read from. Writing it down is what stops the next sign-in on this
			// device from proposing the whole vault again.
			await persistMode("folders");
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
			vaultSyncing = true;
			vaultPaused = folder ? folder.shouldConnect === false : false;
			vaultLines = FIRST_SYNC_LINES;
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : "Could not start syncing this vault";
		}
	}

	async function persistMode(next: VaultSyncMode) {
		await plugin.relayOnPremSettings.update((current) =>
			withUpdatedSyncMode(current, KNAP_SERVER_ID, next),
		);
	}

	/** A share the server says it has never heard of is already gone. */
	function alreadyGone(e: unknown): boolean {
		return e instanceof Error && /^Failed to delete share: 404\b/.test(e.message);
	}

	/**
	 * Flip between the whole vault and individual folders.
	 *
	 * The point of doing it here rather than leaving somebody to unshare by
	 * hand is that both sides move together. Unsharing folders one at a time
	 * used to leave the plugin syncing nothing and the server still holding
	 * the shares, and nothing in either half noticed the disagreement.
	 *
	 * So the removals go first and the setting is written only once they have
	 * all landed. A refusal stops the run: what was already removed stays
	 * removed, the setting still says what is actually happening, and pressing
	 * the toggle again picks up from there.
	 */
	async function setMode(next: VaultSyncMode) {
		if (switching || next === mode) return;
		const clients = shareClients();
		if (!clients) {
			error = "Sign in first.";
			return;
		}
		error = "";

		const mine: LocalShare[] = plugin.sharedFolders
			.items()
			.map((folder) => ({ id: folder.guid, isVaultScope: folder.isVaultScope }));
		const plan = planModeSwitch(next, mine);

		const agreed = await confirmDialog(
			plugin.app,
			switchConfirmation(next, plan.remove.length),
		);
		if (!agreed) return;

		switching = true;
		try {
			for (const id of plan.remove) {
				try {
					await clients.deleteShare(KNAP_SERVER_ID, id);
				} catch (e: unknown) {
					if (!alreadyGone(e)) {
						error = switchFailedLine(
							next,
							e instanceof Error ? e.message : "Knap did not answer",
						);
						return;
					}
				}
				const local = plugin.sharedFolders.find((folder) => folder.guid === id);
				if (local) {
					plugin.sharedFolders.delete(local);
				}
			}
			await persistMode(next);

			vaultSyncing = false;
			vaultPaused = false;
			vaultLines = [];
			if (plan.createVaultShare) {
				await startSyncingTheVault(next);
			} else {
				vaultLines = [
					foldersInsteadLine(
						plugin.sharedFolders
							.items()
							.filter((folder) => !folder.isVaultScope).length,
					),
				];
			}
			new Notice(switchedNotice(next));
		} finally {
			// Whatever happened, the file explorer's marks are stale: the run
			// removes shares one at a time and an abort halfway leaves some of
			// them gone.
			plugin.folderNavDecorations?.quickRefresh();
			switching = false;
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
			<div class="knap-account-actions">
				{#if server}
					<button class="knap-btn" on:click={() => dispatch("openShares", { server })}>
						Synced folders
					</button>
				{/if}
				<button class="knap-btn" on:click={signOut}>Sign out</button>
			</div>
		</div>
		<!-- The one thing there is to decide about this vault, and it lives here
		     rather than on Knap's own page: everything about the vault is set in
		     Obsidian (ADR-0031), and the page reports what came of it. -->
		<div class="knap-mode">
			<div
				class="checkbox-container"
				class:is-enabled={mode === "folders"}
				class:is-disabled={switching}
				role="switch"
				aria-checked={mode === "folders"}
				aria-label={FOLDERS_TOGGLE_LABEL}
				tabindex="0"
				on:click={() => {
					void setMode(mode === "folders" ? "whole-vault" : "folders");
				}}
				on:keypress={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						void setMode(mode === "folders" ? "whole-vault" : "folders");
					}
				}}
			>
				<div class="checkbox-toggle"></div>
			</div>
			<div class="knap-mode-text">
				<div class="knap-mode-label">{FOLDERS_TOGGLE_LABEL}</div>
				<div class="knap-mode-hint">{foldersToggleHint(mode)}</div>
			</div>
		</div>
		{#if instruction}
			<p class="knap-signin-hint">{instruction}</p>
		{/if}
		{#each vaultLines as line}
			<p class="knap-signin-hint">{line}</p>
		{/each}
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

	.knap-mode {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		width: 100%;
	}

	.knap-mode-text {
		min-width: 0;
	}

	.knap-mode-label {
		color: var(--text-normal);
		font-size: var(--font-ui-small, 13px);
	}

	.knap-mode-hint {
		margin-top: 2px;
		color: var(--text-muted);
		font-size: 12px;
		max-width: 46em;
	}

	.knap-mode .checkbox-container.is-disabled {
		opacity: 0.6;
		pointer-events: none;
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
