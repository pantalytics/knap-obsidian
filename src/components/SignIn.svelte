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
		UNLINK_EXPLANATION,
		UNLINK_LABEL,
		REPLACE_FOLDERS_LABEL,
		type LocalShare,
		type ShareLike,
	} from "../vaultShare";
	import { RelayOnPremShareClientManager } from "../RelayOnPremShareClientManager";
	import {
		syncInstruction,
		PAUSED,
		SIGNED_OUT,
		UP_TO_DATE,
		type SyncWord,
	} from "../syncStatus";
	import type { VaultReading } from "../vaultStatus";
	import { CHECKLIST, CHECKLIST_TITLE } from "../setupChecklist";
	import {
		screenFor,
		showsChecklist,
		showsLinkedVault,
		showsVaultState,
		ACCOUNT_ROW_LABEL,
		FAULT_REPORTING_LABEL,
		FAULT_REPORTING_NOTE,
		NOT_SYNCING_NOTE,
		NOT_SYNCING_TITLE,
		TRY_AGAIN_LABEL,
		UNREACHABLE_NOTE,
		UNREACHABLE_TITLE,
		VAULT_ROW_LABEL,
	} from "../settingsScreen";
	import {
		ANOTHER_DEVICE_NOTE,
		ANOTHER_DEVICE_STEPS,
		ANOTHER_DEVICE_TITLE,
		KNAP_PLUGIN_REPO,
		PASTE_LABEL,
	} from "../anotherDevice";

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
	// Whether the link is being taken off, so the button says so and cannot be
	// pressed twice.
	let unlinking = false;
	// Somebody who has signed in here before is signed OUT, which is a state
	// with its own words and its own button. Somebody who never has is simply
	// new, and gets told what the button is for instead: the signed-out
	// instruction promises their notes are still on this device, which is true
	// and beside the point on an install that has never synced anything.
	$: returning = Boolean(server?.lastUserEmail);
	// The instruction under the word, on the one screen that has a word to put
	// it under. It used to be blanked whenever `counts` was set, so *Leave
	// Obsidian open until it finishes* was on screen only while nothing was
	// counting: during the sync it warns about, it was gone. It was blanked to
	// stop the first-sync notice saying it at the same moment, and the notice
	// is a few seconds of a sync that runs for an hour. The pane keeps it.
	//
	// Up to date returns an empty string from the shared list, so nothing is
	// drawn and nothing is invented here.
	$: statusNote = syncInstruction(word);

	// How many folder shares an older build left behind, and whether the
	// clean-up that replaces them is running. Zero on every install that never
	// picked folders, which is the only shape a new one can be in.
	let leftoverFolders = 0;
	let replacing = false;

	// Knap did not answer the last time the account's vaults were asked for.
	// It is a screen of its own rather than a red line at the bottom of the
	// pane, and only when the list was what the screen was for: a cloud vault
	// already mounted goes on syncing whatever the listing did.
	let unreachable = false;

	// What the linked cloud vault is called when there is nothing to fetch it
	// from, which is every screen where somebody is signed out. The link was
	// not undone by the session ending and the screen says so.
	let rememberedName = plugin.linkedVaultName();

	// Whether a cloud vault is mounted, which is the fact rather than the
	// answer the last fetch happened to give. Read on the same tick as the
	// rest, so unlinking and joining both land without anything telling this
	// component about it.
	let mounted = hasVaultShare();

	$: screen = screenFor({
		signedIn: auth.isSignedIn,
		returning,
		linked: mounted,
		unreachable,
	});

	// The name to print. What Knap called it if the list came back, and the
	// record on disk otherwise.
	$: linkedName = syncingWith?.path ?? rememberedName;

	function hasVaultShare(): boolean {
		return plugin.sharedFolders?.items().some((folder) => folder.isVaultScope) ?? false;
	}

	// Whether the account's vaults are being asked for again, so the button
	// says so and cannot be pressed twice.
	let asking = false;

	/**
	 * Ask Knap for the account's vaults again.
	 *
	 * The listing ran on mount and after a sign-in and nowhere else, so a
	 * refused one left the settings tab with no way forward: closing it and
	 * opening it again was the only route back. The work is a function that
	 * already existed; what was missing was somewhere to press.
	 */
	async function askAgain() {
		if (asking) return;
		asking = true;
		try {
			await startSyncingTheVault();
		} finally {
			asking = false;
		}
	}

	/**
	 * The marks over the state word. Hairline strokes at one weight, so the
	 * four of them read as one set, and `currentColor` so the dot classes in
	 * the stylesheet stay the only place a state has a colour.
	 *
	 * Static strings, rendered with `{@html}`: nothing here comes from a note,
	 * a vault name or a server.
	 */
	const MARK = {
		sync: `<svg width="34" height="34" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 20a12 12 0 0 1 23 0"/><path d="M33 12.5 31 20l-6-4"/><path d="M32 20a12 12 0 0 1-23 0"/><path d="M7 27.5 9 20l6 4"/></svg>`,
		ok: `<svg width="34" height="34" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="20" cy="20" r="14"/><path d="m14 20.5 4.2 4.2L26.5 16"/></svg>`,
		off: `<svg width="34" height="34" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="20" cy="20" r="14"/><path d="M14.5 14.5 25.5 25.5"/></svg>`,
		wait: `<svg width="34" height="34" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 27a6.5 6.5 0 0 1 .6-13 9 9 0 0 1 17 2.2A5.6 5.6 0 0 1 29.6 27z"/></svg>`,
		error: `<svg width="34" height="34" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="20" cy="20" r="14"/><path d="M20 13v9"/><path d="M20 26.3v.2"/></svg>`,
	};

	/**
	 * The mark for the word, so a paused vault does not wear the syncing one.
	 * The word comes from the shared list and this only picks a drawing for it.
	 */
	function markFor(state: SyncWord): string {
		if (state === UP_TO_DATE) return MARK.ok;
		if (state === SIGNED_OUT) return MARK.off;
		if (state === PAUSED) return MARK.wait;
		return MARK.sync;
	}

	/** The mark on a row that opens, and on one that leads out of Obsidian. */
	const CHEVRON = `<svg class="knap-chevron" width="7" height="12" viewBox="0 0 7 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m1 1 5 5-5 5"/></svg>`;

	const LEAVES = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h6v6M12.5 3.5 6 10"/><path d="M11 9.5v3h-8v-8h3"/></svg>`;

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
			//
			// The link does not go with it. Nothing about which cloud vault
			// this one belongs to was undone by a session ending, and the one
			// thing worth seeing before pressing Sign in again is which vault
			// you are about to be back on. `syncingWith` used to be cleared
			// here, which also put `Before you start` in front of somebody who
			// had been syncing since August, because the list rendered on the
			// absence of a link.
			choices = undefined;
			unreachable = false;
			rememberedName = plugin.linkedVaultName() ?? syncingWith?.path;
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
		const ticker = window.setInterval(refreshReading, 1000);
		return () => window.clearInterval(ticker);
	});

	/** The one reading this screen and the corner of the window both draw on. */
	function refreshReading() {
		reading = plugin.readVaultStatus();
		mounted = hasVaultShare();
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

		// Before the folders are read, never after: if the share record did
		// not survive the last update, the vault somebody picked goes back on
		// before this screen counts what is syncing (#64). Idempotent, and it
		// does nothing at all in the ordinary case.
		plugin.restoreRememberedVault();

		const folders = plugin.sharedFolders.items();
		const vaultShare = folders.find((folder) => folder.isVaultScope);
		const local = {
			vaultShareId: vaultShare?.guid,
			folderShareCount: folders.filter((folder) => !folder.isVaultScope).length,
		};

		let remote: ShareLike[] = [];
		try {
			remote = (await clients.listShares(KNAP_SERVER_ID)) as ShareLike[];
		} catch (e: unknown) {
			// The list is the screen, so there is nothing to draw without it.
			// Say Knap could not be reached rather than showing an empty
			// account, which is a different thing and has a button on it.
			//
			// `hold(true)` is the half that was missing. Returning here left
			// `vaultHeld` at its default with no folders mounted, and
			// `vaultSyncWord(true, [], false)` answers Up to date: a green dot
			// over a vault syncing nothing, in the corner of the window as
			// well as here. A vault that cannot be told what to belong to is
			// standing still, and Paused is the word for that.
			unreachable = true;
			error = "";
			hold(true);
			return;
		}
		unreachable = false;

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
	 * End the link between this local vault and the cloud vault it syncs.
	 *
	 * **Local only, and that is the whole design of it.** Nothing is deleted on
	 * either side: the share stays on Knap with every note in it, this device
	 * keeps every note on disk, and linking again picks the two back up. That
	 * is what separates it from Delete vault (ADR-0047), which takes the
	 * documents with it and is a different question asked on a different page.
	 *
	 * `SharedFolders.delete` is what forgets the link as well, wired there
	 * rather than here so that every way a vault share comes off clears the
	 * memory with it.
	 */
	async function unlink() {
		if (unlinking) return;
		// The forty words that used to sit under this button on every open are
		// asked here instead, once, by the person who is about to press it.
		// Nothing is deleted on either side, which is exactly what the sentence
		// is for and exactly what is worth reading at the moment of deciding
		// rather than on every visit to the tab.
		const agreed = await confirmDialog(plugin.app, UNLINK_EXPLANATION);
		if (!agreed) return;
		unlinking = true;
		error = "";
		try {
			for (const mounted of plugin.sharedFolders.items()) {
				if (!mounted.isVaultScope) continue;
				plugin.sharedFolders.delete(mounted);
			}
			syncingWith = undefined;
			rememberedName = undefined;
			mounted = hasVaultShare();
			plugin.folderNavDecorations?.quickRefresh();
			// Back to the list, so the screen somebody lands on after unlinking
			// is the one that offers the next answer rather than an empty panel.
			await startSyncingTheVault();
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : "Could not unlink this vault";
		} finally {
			unlinking = false;
		}
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
			attachShare(joined.id, joined.path);
			syncingWith = joined;
			rememberedName = joined.path;
			mounted = hasVaultShare();
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
	 * Link this local vault to a cloud vault, wherever the choice came from.
	 *
	 * The empty path is the vault root, and "vault" is the scope that makes
	 * every path in the share resolve without a prefix.
	 *
	 * **Linking replaces, it does not append.** A local vault is linked to at
	 * most one cloud vault, so anything already covering the vault comes off
	 * first. `SharedFolder._new` does refuse a second share at the same path,
	 * but only against what is mounted, and the case that produced #71 is
	 * exactly the one where nothing is: an update where the share did not come
	 * back, the screen offering the list again, and the answer landing beside
	 * the old row instead of on top of it.
	 */
	function attachShare(shareId: string, name?: string) {
		for (const mounted of plugin.sharedFolders.items()) {
			if (!mounted.isVaultScope) continue;
			if (mounted.guid === shareId) continue;
			plugin.sharedFolders.delete(mounted);
		}
		const folder = plugin.sharedFolders.new("", shareId, "relay-onprem", false, "vault");
		if (folder?.settings) {
			folder.settings.onpremServerId = KNAP_SERVER_ID;
		}
		// Written down beside the share, which is the whole of #64: this is
		// the one moment a person answers which cloud vault this one syncs,
		// and they are not asked it twice.
		plugin.rememberVault({ id: shareId, name, serverId: KNAP_SERVER_ID });
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

	/**
	 * Put the repository on the clipboard, because it is going to be typed on
	 * a phone otherwise.
	 *
	 * The label goes back after a couple of seconds rather than staying on
	 * Copied, so a second device later gets the same button it had the first
	 * time.
	 */
	let copied = false;
	function copyRepo() {
		void navigator.clipboard
			?.writeText(KNAP_PLUGIN_REPO)
			.then(() => {
				copied = true;
				window.setTimeout(() => {
					copied = false;
				}, 2000);
			})
			.catch(() => {
				// No clipboard, which a phone webview is allowed not to have.
				// The address is on the screen either way.
				new Notice("Copy it from the line above.");
			});
	}

	// The fault-reporting switch (ADR-0071). The plugin reports that it
	// failed, never what it held, and this is the way out of even that. The
	// row is here for everybody, signed in or not: faults do not wait for an
	// account. main.ts subscribes to the setting and flips the reporter, so
	// this component only writes the answer down.
	let faultReporting =
		plugin.reportingSettings.get().faultReporting !== false;
	function toggleFaultReporting() {
		faultReporting = !faultReporting;
		void plugin.reportingSettings.update((s) => ({
			...s,
			faultReporting,
		}));
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

<!-- One state, one screen, and everything else a row away.
     `settingsScreen.ts` names which of the five this is, and the branches below
     draw exactly one of them. Nothing here decides for itself whether to
     render: that was how four screens nobody designed came to exist, among them
     a red dot on a fresh install and Before you start in front of somebody who
     had been syncing for a month. -->
<div class="knap">
	{#if screen === "new"}
		<!-- No account has ever been used here, so there is nothing to report
		     and one thing to press. The state of a vault that has never synced
		     is not a state: saying Signed out with the error dot put a failure
		     light on an install where nothing had gone wrong. -->
		<div class="knap-hero">
			<span class="knap-mark knap-mark-wait">{@html MARK.wait}</span>
			<p class="knap-hero-word">{NOT_SYNCING_TITLE}</p>
			<p class="knap-hero-note">{NOT_SYNCING_NOTE}</p>
			<div class="knap-hero-act">
				<button class="knap-btn mod-cta" disabled={signingIn} on:click={signIn}>
					{signingIn ? "Waiting for the browser" : "Sign in"}
				</button>
			</div>
		</div>
	{:else if screen === "signedOut"}
		<div class="knap-hero">
			<span class="knap-mark knap-mark-{dot}">{@html markFor(word)}</span>
			<p class="knap-hero-word">{word}</p>
			<p class="knap-hero-note">{syncInstruction(word)}</p>
			<div class="knap-hero-act">
				<!-- Not "Sign in again": the line directly above already ends
				     with those three words, and a button repeating the end of
				     its own sentence is the stutter this screen was full of. -->
				<button class="knap-btn mod-cta" disabled={signingIn} on:click={signIn}>
					{signingIn ? "Waiting for the browser" : "Sign in"}
				</button>
			</div>
		</div>
	{:else if screen === "unreachable"}
		<!-- The list was the screen and it did not come back. What a person
		     wants from a failure they cannot fix is whether anything moved, and
		     a way to ask again: there was neither, and the message landed as a
		     red line below the error-reporting switch. -->
		<div class="knap-hero">
			<span class="knap-mark knap-mark-error">{@html MARK.error}</span>
			<p class="knap-hero-word">{UNREACHABLE_TITLE}</p>
			<p class="knap-hero-note">{UNREACHABLE_NOTE}</p>
			<div class="knap-hero-act">
				<button class="knap-btn" disabled={asking} on:click={askAgain}>
					{asking ? "Asking" : TRY_AGAIN_LABEL}
				</button>
			</div>
		</div>
	{:else if screen === "choose"}
		<!-- The list is the whole screen. Each row is a vault, and it says only
		     what tells one vault from another: the name, and the day it was
		     made on the rows where two share a name. -->
		{#if leftoverFolders === 0}
			<p class="knap-group-title">{CHOOSE_A_VAULT}</p>
			{#if choices && choices.length > 0}
				<div class="knap-group">
					{#each choices as vault (vault.id)}
						<button
							class="knap-row knap-row-press"
							disabled={Boolean(joining)}
							on:click={() => join(vault)}
						>
							<span class="knap-row-body">
								<span class="knap-row-label">{vault.path}</span>
								{#each vaultRowLines(vault, choices) as fact}
									<span class="knap-row-fact">{fact}</span>
								{/each}
							</span>
							<!-- The word, not a chevron. #71 was a local vault pointed
							     at the wrong cloud vault for days and nothing on any
							     screen named the act; Link is the name of it
							     (ADR-0066). -->
							<span class="knap-row-trail knap-row-do">
								{joining === vault.id ? "Linking" : JOIN_LABEL}
							</span>
						</button>
					{/each}
				</div>
			{:else if choices}
				<p class="knap-group-note">{NO_VAULTS_YET}</p>
			{/if}
			<div class="knap-group">
				<button
					class="knap-row knap-row-press knap-row-accent"
					disabled={Boolean(joining)}
					on:click={() => join()}
				>
					<span class="knap-row-body">
						<span class="knap-row-label"
							>{joining === "new" ? "Working on it" : NEW_VAULT_LABEL}</span
						>
					</span>
					<span class="knap-row-trail">{@html CHEVRON}</span>
				</button>
			</div>

			<!-- The list of things to sort out, on the one screen where it can be
			     acted on and split into rows. Together the three ran to a hundred
			     and thirty words in front of the button that starts the sync; four
			     words each costs three lines, and the sentence is one press away. -->
			{#if showsChecklist(screen)}
				<p class="knap-group-title">{CHECKLIST_TITLE}</p>
				<div class="knap-group">
					{#each CHECKLIST as item}
						<details class="knap-open">
							<summary class="knap-row">
								<span class="knap-row-body">
									<span class="knap-row-label">{item.title}</span>
								</span>
								<span class="knap-row-trail">{@html CHEVRON}</span>
							</summary>
							<p class="knap-open-body">{item.detail}</p>
						</details>
					{/each}
				</div>
			{/if}
		{/if}

		<!-- The one button on this screen about what syncs, and it is here to
		     be grown out of: it exists for vaults an older build left syncing
		     folders, and it goes the moment they are gone. -->
		{#if leftoverFolders > 0}
			<p class="knap-group-note">{vaultLines.join(" ")}</p>
			<div class="knap-group">
				<button class="knap-row knap-row-press knap-row-accent" disabled={replacing} on:click={replaceFolders}>
					<span class="knap-row-body">
						<span class="knap-row-label"
							>{replacing ? "Working on it" : REPLACE_FOLDERS_LABEL}</span
						>
					</span>
					<span class="knap-row-trail">{@html CHEVRON}</span>
				</button>
			</div>
		{/if}
	{:else}
		<!-- Linked, so the state of the sync is the screen. The count and the
		     bar are the shared reading, unchanged; what moved is where they
		     sit. A bar two pixels tall on a negative margin under a row is the
		     thing somebody watches for an hour. -->
		<div class="knap-hero">
			<span class="knap-mark knap-mark-{dot}">{@html markFor(word)}</span>
			<p class="knap-hero-word">{word}</p>
			{#if counts}
				<p class="knap-hero-count">{counts}</p>
			{/if}
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
			{#if statusNote}
				<p class="knap-hero-note">{statusNote}</p>
			{/if}
		</div>
	{/if}

	<!-- The vault, the account and the way out of both. One group, in the same
	     order on every screen that has them, and each row opens to whatever it
	     is about rather than printing it on arrival. -->
	{#if auth.isSignedIn || (showsLinkedVault(screen) && linkedName)}
		<div class="knap-group">
			{#if showsLinkedVault(screen) && linkedName}
				{#if screen === "linked"}
					<details class="knap-open">
						<summary class="knap-row">
							<span class="knap-row-body">
								<span class="knap-row-label">{VAULT_ROW_LABEL}</span>
							</span>
							<span class="knap-row-trail">
								<span class="knap-row-value">{linkedName}</span>
								{@html CHEVRON}
							</span>
						</summary>
						<div class="knap-open-body">
							<button class="knap-btn" disabled={unlinking} on:click={unlink}>
								{unlinking ? "Unlinking" : UNLINK_LABEL}
							</button>
						</div>
					</details>
				{:else}
					<div class="knap-row">
						<span class="knap-row-body">
							<span class="knap-row-label">{VAULT_ROW_LABEL}</span>
						</span>
						<span class="knap-row-trail">
							<span class="knap-row-value">{linkedName}</span>
						</span>
					</div>
				{/if}
			{/if}

			{#if auth.isSignedIn}
				<details class="knap-open">
					<summary class="knap-row">
						<span class="knap-row-body">
							<span class="knap-row-label">{ACCOUNT_ROW_LABEL}</span>
						</span>
						<span class="knap-row-trail">
							<span class="knap-row-value">{auth.email ?? "Signed in"}</span>
							{@html CHEVRON}
						</span>
					</summary>
					<div class="knap-open-body">
						<button class="knap-btn" on:click={signOut}>Sign out</button>
					</div>
				</details>

				<!-- Not a button: a place you go. Everything about the vault is
				     set here (ADR-0031), so this leads to the half that
				     reports. -->
				<button class="knap-row knap-row-press knap-row-accent" on:click={openDashboard}>
					<span class="knap-row-body">
						<span class="knap-row-label">Dashboard</span>
					</span>
					<span class="knap-row-trail">{@html LEAVES}</span>
				</button>
			{/if}
		</div>
	{/if}

	<!-- The end of the flow, and the day somebody wants their phone on it. One
	     row, opening to the three steps and the string BRAT's field takes. -->
	{#if screen === "linked"}
		<div class="knap-group">
			<details class="knap-open">
				<summary class="knap-row">
					<span class="knap-row-body">
						<span class="knap-row-label">{ANOTHER_DEVICE_TITLE}</span>
					</span>
					<span class="knap-row-trail">{@html CHEVRON}</span>
				</summary>
				<div class="knap-open-body">
					<ol class="knap-steps">
						{#each ANOTHER_DEVICE_STEPS as step}
							<li>{step}</li>
						{/each}
					</ol>
					<div class="knap-paste">
						<span class="knap-paste-label">{PASTE_LABEL}</span>
						<code class="knap-paste-value">{KNAP_PLUGIN_REPO}</code>
						<button class="knap-btn knap-btn-mini" on:click={copyRepo}>
							{copied ? "Copied" : "Copy"}
						</button>
					</div>
					<p class="knap-open-note">{ANOTHER_DEVICE_NOTE}</p>
				</div>
			</details>
		</div>
	{/if}

	<!-- What the plugin says when it breaks, and the way to say nothing. The
	     forty-five words listing what is sent buried the half that is a
	     promise, so the promise is the line (ADR-0003). -->
	<div class="knap-group">
		<div
			class="knap-row"
			role="checkbox"
			aria-checked={faultReporting}
			aria-label={FAULT_REPORTING_LABEL}
			tabindex="0"
			on:click={toggleFaultReporting}
			on:keypress={(e) => {
				if (e.key === "Enter" || e.key === " ") toggleFaultReporting();
			}}
		>
			<span class="knap-row-body">
				<span class="knap-row-label">{FAULT_REPORTING_LABEL}</span>
			</span>
			<span class="knap-row-trail">
				<span class="knap-switch" class:is-on={faultReporting}></span>
			</span>
		</div>
	</div>
	<p class="knap-group-note">{FAULT_REPORTING_NOTE}</p>

	<!-- Beside what caused it, never at the far end of the scroll. -->
	{#if error}
		<div class="knap-error">{error}</div>
	{/if}
</div>

<style>
	.knap {
		display: flex;
		flex-direction: column;
		max-width: 34em;
	}

	/* The state of the vault, which is the reason the tab was opened. */
	.knap-hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		padding: 22px 8px 26px;
	}

	.knap-mark {
		display: block;
		color: var(--text-faint);
		margin-bottom: 14px;
	}

	.knap-mark-ok {
		color: var(--color-green, #28a745);
	}

	.knap-mark-working {
		color: var(--interactive-accent);
	}

	.knap-mark-error {
		color: var(--text-error);
	}

	.knap-hero-word {
		margin: 0;
		font-size: var(--font-ui-large, 20px);
		font-weight: var(--font-semibold, 600);
		letter-spacing: -0.02em;
		color: var(--text-normal);
	}

	.knap-hero-count {
		margin: 4px 0 0;
		font-size: var(--font-ui-small, 13px);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.knap-hero-note {
		margin: 6px 0 0;
		font-size: var(--font-ui-smaller, 12px);
		color: var(--text-muted);
		max-width: 30em;
	}

	.knap-hero-act {
		margin-top: 18px;
	}

	/* Wide enough to read from a metre away, which a two-pixel line hanging
	   off a row's negative margin was not. */
	.knap-track {
		width: 100%;
		max-width: 22em;
		height: 4px;
		border-radius: 2px;
		background: var(--background-modifier-border);
		overflow: hidden;
		margin: 14px 0 0;
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

	/* A group of rows, the shape Obsidian's own lists and every settings app
	   a person already uses share. */
	.knap-group {
		background: var(--background-secondary);
		border-radius: var(--radius-m, 8px);
		overflow: hidden;
		margin-top: 8px;
	}

	.knap-hero + .knap-group {
		margin-top: 0;
	}

	.knap-group-title {
		margin: 22px 0 6px 14px;
		font-size: var(--font-ui-smaller, 12px);
		font-weight: var(--font-medium, 500);
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.knap-group-note {
		margin: 6px 14px 0;
		font-size: var(--font-ui-smaller, 12px);
		color: var(--text-faint);
		line-height: 1.45;
	}

	.knap-row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		padding: 11px 14px;
		background: transparent;
		border: 0;
		box-shadow: none;
		border-radius: 0;
		height: auto;
		white-space: normal;
		font: inherit;
		font-size: var(--font-ui-medium, 15px);
		color: var(--text-normal);
		text-align: left;
		position: relative;
	}

	/* The hairline sits inside the group and starts where the text does, so a
	   run of rows reads as one object rather than as a stack of boxes. */
	.knap-group > * + * .knap-row::before,
	.knap-group > * + *.knap-row::before {
		content: "";
		position: absolute;
		top: 0;
		left: 14px;
		right: 0;
		height: 1px;
		background: var(--background-modifier-border);
	}

	.knap-row-press {
		cursor: pointer;
	}

	.knap-row-press:hover:not(:disabled) {
		background: var(--background-modifier-hover);
	}

	.knap-row-press:disabled {
		cursor: default;
		opacity: 0.6;
	}

	/* Obsidian draws focus with a box-shadow, and every custom row here sets
	   `box-shadow: none` to stop looking like a button. Without this the
	   keyboard has no visible position anywhere on the pane. */
	.knap-row:focus-visible,
	.knap-open > summary:focus-visible {
		outline: 2px solid var(--interactive-accent);
		outline-offset: -2px;
	}

	.knap-row-body {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.knap-row-label {
		overflow-wrap: anywhere;
	}

	.knap-row-fact {
		font-size: var(--font-ui-smaller, 12px);
		color: var(--text-faint);
	}

	.knap-row-trail {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-left: auto;
		min-width: 0;
		color: var(--text-faint);
	}

	/* The value wraps rather than sliding off the left edge. A vault called
	   260812_RH_Obsidian_vault lost its front and read as )bsidian_vault, and
	   the front is the half that tells one vault from another. */
	.knap-row-value {
		color: var(--text-muted);
		font-size: var(--font-ui-small, 13px);
		text-align: right;
		overflow-wrap: anywhere;
		min-width: 0;
	}

	.knap-row-accent .knap-row-label {
		color: var(--text-accent);
	}

	.knap-row-do {
		color: var(--text-accent);
		font-size: var(--font-ui-small, 13px);
		white-space: nowrap;
	}

	/* A row that opens. Native details, so the keyboard and the screen reader
	   get it for nothing. */
	.knap-open {
		position: relative;
	}

	.knap-open > summary {
		list-style: none;
		cursor: pointer;
	}

	.knap-open > summary::-webkit-details-marker {
		display: none;
	}

	.knap-open > summary:hover {
		background: var(--background-modifier-hover);
	}

	/* `:global` because the mark is an {@html} string, so Svelte's scoped-CSS
	   pass cannot see the class and drops the rule. It stays scoped in
	   practice: nothing outside this component is inside a `.knap-open`. */
	.knap-open > summary :global(.knap-chevron) {
		transition: transform 180ms ease;
	}

	.knap-open[open] > summary :global(.knap-chevron) {
		transform: rotate(90deg);
	}

	@media (prefers-reduced-motion: reduce) {
		.knap-open > summary :global(.knap-chevron) {
			transition: none;
		}
	}

	.knap-open-body {
		padding: 0 14px 13px;
		font-size: var(--font-ui-smaller, 12px);
		line-height: 1.5;
		color: var(--text-muted);
	}

	.knap-open-note {
		margin: 8px 0 0;
	}

	.knap-steps {
		margin: 0;
		padding-left: 18px;
	}

	.knap-steps li {
		margin: 4px 0;
	}

	.knap-paste {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
	}

	.knap-paste-label {
		color: var(--text-faint);
	}

	.knap-paste-value {
		padding: 2px 7px;
		background: var(--background-modifier-form-field, var(--background-primary));
		border-radius: var(--radius-s, 4px);
		color: var(--text-normal);
		font-family: var(--font-monospace);
		overflow-wrap: anywhere;
	}

	.knap-switch {
		width: 36px;
		height: 21px;
		border-radius: 11px;
		background: var(--background-modifier-border);
		position: relative;
		flex: none;
		transition: background 120ms ease;
	}

	.knap-switch.is-on {
		background: var(--interactive-accent);
	}

	.knap-switch::after {
		content: "";
		position: absolute;
		top: 2px;
		left: 2px;
		width: 17px;
		height: 17px;
		border-radius: 50%;
		background: var(--background-primary);
		transition: left 120ms ease;
	}

	.knap-switch.is-on::after {
		left: 17px;
	}

	@media (prefers-reduced-motion: reduce) {
		.knap-switch,
		.knap-switch::after {
			transition: none;
		}
	}

	.knap-btn {
		padding: 6px 16px;
		border-radius: var(--radius-m, 8px);
		cursor: pointer;
	}

	.knap-btn-mini {
		padding: 3px 10px;
		font-size: var(--font-ui-smaller, 12px);
	}

	.knap-btn:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.knap-error {
		margin: 10px 14px 0;
		font-size: var(--font-ui-smaller, 12px);
		color: var(--text-error);
	}

	/* On a phone the pane is narrow and a value pushed against the right edge
	   wraps to a column of two-letter lines. Below this the value drops under
	   its label instead. */
	@media (max-width: 480px) {
		.knap-row {
			align-items: flex-start;
			flex-direction: column;
			gap: 3px;
		}

		.knap-row-trail {
			margin-left: 0;
			width: 100%;
			justify-content: space-between;
		}

		.knap-row-value {
			text-align: left;
		}
	}
</style>
