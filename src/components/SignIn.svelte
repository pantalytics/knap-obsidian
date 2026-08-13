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
		vaultRowLines,
		CHOOSE_A_VAULT,
		JOIN_CONFIRMATION,
		JOIN_LABEL,
		NEW_VAULT_LABEL,
		NO_VAULTS_YET,
		VAULT_SCOPE_NOTE,
		REPLACE_FOLDERS_LABEL,
		type LocalShare,
		type ShareLike,
	} from "../vaultShare";
	import { RelayOnPremShareClientManager } from "../RelayOnPremShareClientManager";
	import { hasSignInButton, syncInstruction } from "../syncStatus";
	import type { VaultReading } from "../vaultStatus";
	import { topHazard, type Hazard } from "../vaultHazards";

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

	// What the vault is doing, worked out by the plugin off the folders and the
	// sync queue, so this row and the mark in the corner of the window cannot
	// say two different things about one vault.
	//
	// Counting a group off the queue, which is what this row did on its own, is
	// one of the three facts behind the word and it was the only one here. It
	// says nothing while the walk that registers the local files is still
	// running, and nothing about the folder's own document, so in that window
	// the row fell back to a flag the sign-in flow set once: a screen opened
	// later over a vault still filling read Up to date. That is #40, and the
	// three facts and the reason for each are in vaultStatus.ts.
	let reading: VaultReading = plugin.readVaultStatus();
	$: word = reading.word;
	$: dot = reading.dot;
	// The count sits beside the word, and the bar under it. Both are phrased by
	// the shared list, so this screen and Knap's page count in the same words.
	$: counts = reading.counts;
	$: progress = reading.progress;

	// The name of this vault in Obsidian. It is the name a new vault on Knap
	// takes, and after that the two are independent: which vault this device
	// syncs with is a choice somebody made, not a name that matched.
	const vaultName = plugin.app.vault.getName();

	// What else is syncing this vault (#41). Read when the screen opens rather
	// than held from load, so turning the other plugin off and coming back
	// here clears it.
	let hazards: Hazard[] = plugin.readVaultHazards();
	// One at a time. Two warnings competing on one screen is how neither gets
	// read, and the one that holds the vault back always wins.
	$: hazard = topHazard(hazards);

	// The vaults on Knap this account reaches, once signing in has asked. The
	// list is the screen: nothing syncs until one of them is pressed, and an
	// empty list is a new account rather than a failure.
	let choices: ShareLike[] | undefined;
	// The vault on Knap this device is syncing with, named. Read off the same
	// list, so the row says what somebody picked rather than what the folder
	// on disk is called.
	let syncingWith: ShareLike | undefined;
	// The one being joined right now, so its row can say so and the rest of
	// the list cannot be pressed underneath it.
	let joining: string | undefined;
	// Somebody who has signed in here before is signed OUT, which is a state
	// with its own words and its own button. Somebody who never has is simply
	// new, and gets told what the button is for instead: the signed-out
	// instruction promises their notes are still on this device, which is true
	// and beside the point on an install that has never synced anything.
	$: returning = Boolean(server?.lastUserEmail);
	// The instruction goes when something truer takes its place. Syncing with a
	// count beside it and a bar under it does not also need a sentence about
	// leaving Obsidian open: that sentence was on screen twice at once, once
	// here and once as the first line of the first sync.
	$: statusNote = !(auth.isSignedIn || returning)
		? "Sign in with your Knap account, then pick the vault this one syncs with."
		: counts
			? ""
			: syncInstruction(word);

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
			// Signing out is not a vault waiting to be told anything. The word
			// for it is Signed out and it has its own button. The list goes
			// with the account it belonged to.
			choices = undefined;
			syncingWith = undefined;
			hold(false);
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
		// A second a tick while this screen is open. Following the sync queue
		// was enough while the count was the only thing on the row. It is not
		// any more: the other two facts change without telling anybody, which
		// is why the corner of the window reads them rather than subscribing.
		// A second rather than the corner's four, because the bar is the thing
		// somebody watches during a first sync and one standing still reads as
		// stuck.
		refreshReading();
		// Once, not on the ticker: what it answers only changes when somebody
		// turns a plugin on or moves the vault, and neither happens while this
		// screen is open. Asked again on open, which is how turning the other
		// plugin off and coming back here clears the warning.
		hazards = plugin.refreshVaultHazards();
		const ticker = window.setInterval(refreshReading, 1000);
		return () => window.clearInterval(ticker);
	});

	/** The one reading this screen and the corner of the window both draw on. */
	function refreshReading() {
		reading = plugin.readVaultStatus();
	}

	/**
	 * A vault standing still, and the corner of the window told about it.
	 *
	 * Without this the screen would say Up to date directly above a paragraph
	 * explaining that nothing is syncing, which is the same lie #40 was about.
	 * The plugin holds the flag rather than this component so the mark in the
	 * corner reads it too.
	 */
	function hold(held: boolean) {
		plugin.vaultHeld = held;
		refreshReading();
	}

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
	 * Ask Knap what this account reaches, and wait to be told which one.
	 *
	 * An account reaches zero, one or many vaults, and each of those can be
	 * open in any number of local vaults. So there is nothing here to work out:
	 * signing in fetches the list and the person picks. The whole vault still
	 * syncs and there is still nothing to pick about how much of it.
	 */
	async function startSyncingTheVault() {
		const clients = shareClients();
		if (!clients) return;

		const folders = plugin.sharedFolders.items();
		const vaultShare = folders.find((folder) => folder.isVaultScope);
		const local = {
			vaultShareId: vaultShare?.guid,
			folderShareCount: folders.filter((folder) => !folder.isVaultScope).length,
		};

		// Something else syncing this vault stops it starting, and never stops
		// one that is already going (#41). It no longer stops the list from
		// being drawn: seeing which vaults exist costs nothing, and a screen
		// that refuses before it has said what it is refusing leaves somebody
		// with a warning and no idea what it is standing in the way of. The
		// checks run against the button instead, in `askFirst`.
		hazards = plugin.refreshVaultHazards();

		let remote: ShareLike[] = [];
		try {
			remote = (await clients.listShares(KNAP_SERVER_ID)) as ShareLike[];
		} catch (e: unknown) {
			// The list is the screen, so there is nothing to draw without it.
			// Say Knap could not be reached rather than showing an empty
			// account, which is a different thing and has a button on it.
			error = e instanceof Error ? e.message : "Could not reach Knap";
			return;
		}

		const decision = decideVaultShare(remote, local);
		if (decision.action === "already-syncing") {
			leftoverFolders = 0;
			choices = undefined;
			// A vault Knap no longer lists leaves the row without a name. That
			// is somebody's vault deleted or unshared while this device was
			// away, and the sync layer is what reports it, so nothing is
			// invented here.
			syncingWith = decision.vault;
			hold(false);
			return;
		}
		if (decision.action === "replace-folders") {
			// An older build let somebody pick folders here. They cannot sit
			// beside a vault share, so the screen offers to take them off rather
			// than doing it on its own: deleting a share takes its documents
			// with it, and a folder somebody else is a member of takes their
			// copy too.
			choices = undefined;
			leftoverFolders = decision.count;
			vaultLines = [replaceFoldersLine(decision.count)];
			return;
		}

		// Nothing joined yet, so the account's vaults go on the screen and the
		// vault stands still until one of them is pressed.
		leftoverFolders = 0;
		vaultLines = [];
		syncingWith = undefined;
		choices = decision.vaults;
		hold(true);
	}

	/**
	 * Join the vault somebody pressed, or start a new one.
	 *
	 * Joining a local vault that already holds files asks once, and that
	 * question is the only one worth asking here: the vault on Knap downloads
	 * into this folder and whatever is here uploads into it, so both end up
	 * holding both. The dialog says that as a combination that loses nothing,
	 * which is the fact somebody needs before answering. An empty vault, which
	 * is what somebody setting up a second device has, goes straight through.
	 *
	 * There is no pre-flight. Detecting what else syncs this folder was a
	 * screen of its own for a while, and it cost three questions and a page to
	 * say something the person setting the vault up already knows.
	 */
	async function join(vault?: ShareLike) {
		if (joining) return;
		const clients = shareClients();
		if (!clients) {
			error = "Sign in first.";
			return;
		}

		if (vault) {
			const here = plugin.app.vault.getFiles().length;
			if (here > 0) {
				const agreed = await confirmDialog(plugin.app, JOIN_CONFIRMATION);
				if (!agreed) return;
			}
		}

		error = "";
		joining = vault ? vault.id : "new";
		try {
			const joined = vault ?? (await createVault(clients));
			attachShare(joined.id);
			syncingWith = joined;
			choices = undefined;
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : "Could not start syncing this vault";
		} finally {
			joining = undefined;
		}
	}

	/**
	 * Start a new vault on Knap from the notes on this device.
	 *
	 * The name comes from Obsidian because there is nowhere else to get one.
	 * It is a name and not a key: nothing matches on it afterwards, so a vault
	 * renamed here later stays the vault it was.
	 */
	async function createVault(clients: RelayOnPremShareClientManager): Promise<ShareLike> {
		const share = await clients.createShare(KNAP_SERVER_ID, {
			path: vaultName,
			kind: "folder",
			visibility: "private",
		});
		return { id: share.id, kind: "folder", path: share.path };
	}

	/**
	 * Start syncing against a share, wherever it came from.
	 *
	 * The empty path is the vault root, and "vault" is the scope that makes
	 * every path in the share resolve without a prefix.
	 */
	function attachShare(shareId: string) {
		const folder = plugin.sharedFolders.new("", shareId, "relay-onprem", false, "vault");
		if (folder?.settings) {
			folder.settings.onpremServerId = KNAP_SERVER_ID;
		}
		plugin.folderNavDecorations?.quickRefresh();
		// The folder is brand new and has caught up with nothing yet, so the
		// row says Syncing the moment it reads it, and the vault is no longer
		// standing still waiting to be told what to do.
		hold(false);
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
				<span class="knap-value-text">{auth.email ?? "Signed in"}</span>
			</div>
		</div>

		<!-- Which vault on Knap this one syncs with, which is a choice somebody
		     made and not a name that matched. It sits above Status because it
		     is the fact the row underneath depends on: the vault named here is
		     the one the word below is about. -->
		{#if syncingWith}
			<div class="setting-item">
				<div class="setting-item-info">
					<div class="setting-item-name">Vault</div>
				</div>
				<div class="setting-item-control knap-value">
					<span class="knap-value-text">{syncingWith.path}</span>
				</div>
			</div>
		{/if}
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
			<span>{counts ? `${word} · ${counts}` : word}</span>
		</div>
	</div>

	<!-- The bar only draws against a real denominator. A bar filling against an
	     unknown total is a spinner wearing a percentage. -->
	{#if progress !== undefined}
		<div
			class="knap-track"
			role="progressbar"
			aria-label="Sync progress"
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={Math.round(progress * 100)}
		>
			<i style="width: {Math.round(progress * 100)}%"></i>
		</div>
	{/if}

	<!-- One warning, never two (#41). A person with a second sync plugin on and
	     a vault in Dropbox has one thing to fix first, and stacking both here
	     is how neither gets read. `topHazard` picks it: anything holding the
	     vault back comes first, the rest wait their turn. -->
	{#if hazard}
		<div class="knap-warning" class:knap-warning-holding={hazard.blocking}>
			{#each hazard.lines as line}
				<p>{line}</p>
			{/each}
		</div>
	{/if}

	<!-- The vaults this account reaches. Every row is what Knap will say about
	     a vault from the outside and nothing more: the name, the day it was
	     made, and whether somebody else owns it. No sentence under it telling
	     somebody to pick one, because the rows are vaults and each carries the
	     word for what pressing it does. -->
	{#if choices}
		<div class="knap-choose">
			<p class="knap-choose-title">{CHOOSE_A_VAULT}</p>
			{#if choices.length === 0}
				<p class="knap-note">{NO_VAULTS_YET}</p>
			{/if}
			{#each choices as vault (vault.id)}
				<button
					class="knap-vault"
					disabled={Boolean(joining)}
					on:click={() => join(vault)}
				>
					<span class="knap-vault-name">{vault.path}</span>
					<span class="knap-vault-facts">
						{#each vaultRowLines(vault) as fact}
							<span>{fact}</span>
						{/each}
					</span>
					<span class="knap-vault-join"
						>{joining === vault.id ? "Joining" : JOIN_LABEL}</span
					>
				</button>
			{/each}
			<button
				class="knap-btn mod-cta"
				disabled={Boolean(joining)}
				on:click={() => join()}
			>
				{joining === "new" ? "Working on it" : NEW_VAULT_LABEL}
			</button>
		</div>
	{/if}

	<!-- Anything the vault still needs said, which is now only the folder
	     clean-up an older build left behind. -->
	{#each vaultLines as line}
		<p class="knap-note">{line}</p>
	{/each}

	<!-- Not a button: a place you go. The glyph says it opens a browser, and
	     the row is the same shape as the two above it. -->
	{#if auth.isSignedIn}
		<button class="setting-item knap-row-link" on:click={openDashboard}>
			<div class="setting-item-info">
				<div class="setting-item-name">Dashboard</div>
			</div>
			<div class="setting-item-control knap-glyph">
				<svg
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M6.5 3.5h6v6M12.5 3.5 6 10" />
					<path d="M11 9.5v3h-8v-8h3" />
				</svg>
			</div>
		</button>
	{/if}

	<div class="knap-actions">
		{#if auth.isSignedIn}
			<!-- Quiet, and on its own: it is the one thing on this screen
			     somebody can regret pressing. -->
			<button class="knap-btn knap-btn-quiet" on:click={signOut}>Sign out</button>
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

	<!-- The one line about what a vault is. It answers the question a bare
	     second device raises, which outlives the upload that raises it. -->
	{#if auth.isSignedIn}
		<p class="knap-foot">{VAULT_SCOPE_NOTE}</p>
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
		/* A long value wraps onto a second line rather than sliding off the
		   left edge of the row. It used to be one line with the overflow
		   hidden, and because the value sits against the right edge, a vault
		   called 260812_RH_Obsidian_vault lost its front and read as
		   )bsidian_vault. The front is the half that tells one vault from
		   another, and the line under this row says the name is the only
		   thing a second device matches on. Ellipsis never ran anyway: the
		   text is an anonymous item inside a flex row, and text-overflow does
		   not reach it. */
		flex-wrap: wrap;
		justify-content: flex-end;
		text-align: right;
		min-width: 0;
	}

	/* The value itself, so it has something to break inside. A vault name is
	   one word as often as not, and a word with no spaces in it needs telling
	   that it may break mid-word. */
	.knap-value-text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.knap-note {
		margin: 8px 0 0;
		color: var(--text-muted);
		font-size: 12px;
		max-width: 46em;
	}

	/* The list of vaults, which is the whole screen while it is up. It is not
	   a setting row: a row shows a value, and this is a question. */
	.knap-choose {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		margin-top: 16px;
		max-width: 46em;
	}

	.knap-choose-title {
		margin: 0 0 8px;
		color: var(--text-normal);
		font-size: 13px;
		font-weight: var(--font-semibold, 600);
	}

	/* One vault, one button, so pressing it anywhere joins it. The facts sit
	   under the name at caption weight, and the words that say what pressing
	   does sit on the right where a value would be. */
	.knap-vault {
		display: grid;
		grid-template-columns: 1fr auto;
		grid-template-areas: "name join" "facts join";
		gap: 2px 12px;
		align-items: center;
		width: 100%;
		padding: 10px 12px;
		margin-top: 6px;
		background: transparent;
		box-shadow: none;
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-s, 4px);
		text-align: left;
		font: inherit;
		cursor: pointer;
	}

	.knap-vault:hover:not(:disabled) {
		background: var(--background-modifier-hover);
		border-color: var(--interactive-accent);
	}

	.knap-vault:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.knap-vault-name {
		grid-area: name;
		color: var(--text-normal);
		font-size: 14px;
		overflow-wrap: anywhere;
	}

	/* Empty on a vault Knap will say nothing else about, and then the row is
	   one line rather than one line and a gap. */
	.knap-vault-facts {
		grid-area: facts;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		color: var(--text-faint);
		font-size: 12px;
	}

	.knap-vault-facts:empty {
		display: none;
	}

	.knap-vault-join {
		grid-area: join;
		color: var(--text-accent);
		font-size: 12px;
		white-space: nowrap;
	}

	/* The new vault sits under the list rather than in it: it is the answer
	   when none of the rows is the one, and on an empty account it is the only
	   thing to press. */
	.knap-choose > .knap-btn {
		align-self: flex-start;
		margin-top: 12px;
	}


	/* One block, never two, so it can afford to be the loudest thing on the
	   screen. A rule down the side rather than a filled panel: this is a
	   settings tab, and a coloured box in the middle of it reads as an error
	   the plugin has hit rather than something to go and do. */
	.knap-warning {
		margin-top: 16px;
		padding: 2px 0 2px 12px;
		border-left: 3px solid var(--text-accent, var(--interactive-accent));
		max-width: 46em;
	}

	/* Deeper when the vault is standing still because of it. The status row
	   says Paused at the same time, so the colour is the second thing that
	   says so rather than the only one. */
	.knap-warning-holding {
		border-left-color: var(--text-error);
	}

	.knap-warning p {
		margin: 6px 0;
		color: var(--text-normal);
		font-size: 13px;
	}

	/* The one permanent line, at caption weight: it is worth saying and it is
	   not the headline. */
	.knap-foot {
		margin: 20px 0 0;
		color: var(--text-faint);
		font-size: 12px;
		max-width: 46em;
	}

	/* Two pixels of fact where two paragraphs used to be. It hangs under the
	   status row rather than beside it, so the row keeps the shape every other
	   setting in the app has. */
	.knap-track {
		height: 2px;
		border-radius: 2px;
		background: var(--background-modifier-border);
		overflow: hidden;
		margin: -4px 0 4px;
	}

	.knap-track > i {
		display: block;
		height: 100%;
		border-radius: 2px;
		background: var(--interactive-accent);
		transition: width 240ms ease-out;
	}

	@media (prefers-reduced-motion: reduce) {
		.knap-track > i {
			transition: none;
		}
	}

	/* A setting row that happens to be a button, so it reads as a place to go
	   and still lines up with the rows above it. */
	.knap-row-link {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		box-shadow: none;
		background: transparent;
		text-align: left;
		font: inherit;
		cursor: pointer;
		border-radius: var(--radius-s, 4px);
	}

	.knap-row-link:hover {
		background: var(--background-modifier-hover);
	}

	.knap-row-link .setting-item-name {
		color: var(--text-accent);
	}

	.knap-glyph {
		display: flex;
		color: var(--text-faint);
	}

	.knap-glyph svg {
		width: 14px;
		height: 14px;
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

	/* Text, not a slab. Signing out is rare and irreversible in the small way
	   that matters: it should not sit at the same weight as the way in. */
	.knap-btn-quiet {
		background: transparent;
		box-shadow: none;
		color: var(--text-muted);
		padding-left: 0;
	}

	.knap-btn-quiet:hover {
		background: transparent;
		color: var(--text-error);
	}

	.knap-form-error {
		margin-top: 12px;
		color: var(--text-error);
		font-size: 12px;
	}
</style>
