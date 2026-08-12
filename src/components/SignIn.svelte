<script lang="ts">
	import { Notice } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import type Live from "../main";
	import {
		KNAP_SERVER_ID,
		KNAP_CONTROL_PLANE_URL,
		KNAP_PANEL_URL,
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
	import { hasSignInButton, syncInstruction } from "../syncStatus";
	import type { VaultReading } from "../vaultStatus";

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

	// What the vault is doing, read off the folders and the sync queue by the
	// plugin, so this row and the mark in the corner of the window cannot say
	// two different things about one vault.
	//
	// It used to be two booleans set here, once, by the sign-in flow: true
	// while this screen made the share and never touched again. That is half
	// of #40. On the next visit both were false and the row said Up to date
	// over a vault that had thousands of notes still to send.
	let reading: VaultReading = plugin.readVaultStatus();
	$: word = reading.word;
	$: dot = reading.dot;
	// Somebody who has signed in here before is signed OUT, which is a state
	// with its own words and its own button. Somebody who never has is simply
	// new, and gets told what the button is for instead: the signed-out
	// instruction promises their notes are still on this device, which is true
	// and beside the point on an install that has never synced anything.
	$: returning = Boolean(server?.lastUserEmail);
	$: statusNote =
		auth.isSignedIn || returning
			? syncInstruction(word)
			: "Sign in with your Knap account and this vault starts syncing.";

	function refreshReading() {
		reading = plugin.readVaultStatus();
	}

	// A second a tick while this screen is open. The bar is the thing somebody
	// watches during a first sync, and four seconds of it standing still reads
	// as stuck.
	onMount(() => {
		refreshReading();
		const ticker = window.setInterval(refreshReading, 1000);
		return () => window.clearInterval(ticker);
	});

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
		refreshReading();
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
			// The folder is brand new and has caught up with nothing yet, so
			// the row says Syncing the moment it reads it.
			refreshReading();
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

	/**
	 * Knap's page, in a browser.
	 *
	 * Everything about the vault is set here (ADR-0031), so this button leads
	 * to the half that reports: which devices sync, and which AI is connected.
	 * It opens a browser rather than a view inside Obsidian, because that is
	 * where somebody is already signed in.
	 */
	function openDashboard() {
		window.open(KNAP_PANEL_URL);
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

<!-- Two rows and two buttons (ADR-0045). Everything that used to sit here as a
     sentence is either a row's value or the note under it, so the screen reads
     like the settings pages either side of it: Obsidian's own setting-item,
     label on the left and value on the right. -->
<div class="knap-signin">
	{#if auth.isSignedIn}
		<div class="setting-item">
			<div class="setting-item-info">
				<div class="setting-item-name">Account</div>
			</div>
			<div class="setting-item-control knap-value">
				{auth.email ?? "Signed in"}
			</div>
		</div>
	{/if}

	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Status</div>
			{#if statusNote}
				<div class="setting-item-description">{statusNote}</div>
			{/if}
		</div>
		<div class="setting-item-control knap-value">
			<span class="knap-dot knap-dot-{dot}"></span>
			<span>{word}</span>
			{#if reading.counts}
				<span class="knap-count">{reading.counts}</span>
			{/if}
		</div>
	</div>

	<!-- The bar, while notes are moving (#41). This is the machine doing the
	     work, so the count and the bar belong here as much as on Knap's own
	     page: adopting a vault of a few thousand notes is hours, and one word
	     is not enough to sit through it. Both are drawn from the same numbers
	     the corner of the window uses. -->
	{#if reading.progress !== undefined}
		<!-- aria-hidden because the row above already says the same thing in
		     words, and a screen reader that reads the count and then the bar
		     has said it twice. -->
		<div class="knap-bar" aria-hidden="true">
			<div class="knap-bar-fill" style:width="{Math.round(reading.progress * 100)}%"></div>
		</div>
	{/if}

	<!-- What a first sync needs said while it runs, and nothing after it. -->
	{#each vaultLines as line}
		<p class="knap-note">{line}</p>
	{/each}

	<div class="knap-actions">
		{#if auth.isSignedIn}
			<button class="knap-btn" on:click={signOut}>Logout</button>
			<button class="knap-btn" on:click={openDashboard}>Dashboard</button>
		{:else if hasSignInButton(word)}
			<button class="knap-btn mod-cta" disabled={signingIn} on:click={signIn}>
				{signingIn
					? "Waiting for the browser"
					: returning
						? "Sign in again"
						: "Sign in"}
			</button>
		{/if}
	</div>

	{#if signingIn}
		<p class="knap-note">
			Finish in the browser window that just opened. Obsidian picks it up from
			there.
		</p>
	{/if}

	<!-- The only button on this screen about what syncs, and it is here to be
	     grown out of: it exists for vaults an older build left syncing folders,
	     and it goes the moment they are gone. -->
	{#if leftoverFolders > 0}
		<button class="knap-btn mod-cta" disabled={replacing} on:click={replaceFolders}>
			{replacing ? "Working on it" : REPLACE_FOLDERS_LABEL}
		</button>
	{/if}

	{#if error}
		<div class="knap-form-error">{error}</div>
	{/if}
</div>

<style>
	/* Stretch, not flex-start: a setting row has to span the pane for the
	   value to sit against the right edge, the way every other row in
	   Obsidian's settings does. */
	.knap-signin {
		display: flex;
		flex-direction: column;
		align-items: stretch;
	}

	/* The rows are Obsidian's, so only the value side needs anything: a dot
	   next to a word, and the same muted weight the app gives a setting's
	   current value. */
	.knap-value {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-muted);
		font-size: var(--font-ui-small, 13px);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.knap-note {
		margin: 8px 0 0;
		color: var(--text-muted);
		font-size: 12px;
		max-width: 46em;
	}

	/* Tabular figures so the count does not shuffle sideways every time a
	   note lands. */
	.knap-count {
		font-variant-numeric: tabular-nums;
	}

	.knap-bar {
		height: 4px;
		margin-top: 10px;
		border-radius: 2px;
		background: var(--background-modifier-border);
		overflow: hidden;
	}

	.knap-bar-fill {
		height: 100%;
		background: var(--interactive-accent);
		transition: width 200ms ease-out;
	}

	.knap-actions {
		display: flex;
		gap: 8px;
		margin-top: 16px;
		align-self: flex-start;
	}

	.knap-actions:empty {
		display: none;
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
		padding: 6px 14px;
		cursor: pointer;
	}

	/* The clean-up button stands on its own rather than in the actions row, so
	   it needs the same shrink-to-fit the row gets. */
	.knap-signin > .knap-btn {
		align-self: flex-start;
		margin-top: 12px;
	}

	.knap-btn:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.knap-form-error {
		margin-top: 12px;
		color: var(--text-error);
		font-size: 12px;
	}
</style>
