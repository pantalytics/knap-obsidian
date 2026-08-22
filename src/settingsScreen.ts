"use strict";

/**
 * Which of the five screens the settings tab is showing, and why that is a
 * function rather than a pile of conditions in the markup.
 *
 * Every block on the pane used to decide for itself whether to render, off
 * whatever variable was nearest. Six screens came out of that and four of them
 * were nobody's decision, which is where these came from:
 *
 * - **A vault that has never signed in read `Signed out` with the error dot.**
 *   `vaultSyncWord` answers for a vault, and on a fresh install there is no
 *   vault relationship to answer about. The first thing a new person saw was a
 *   failure light.
 * - **`Before you start` rendered whenever no vault was linked**, and signing
 *   out clears the linked vault, so somebody who had been syncing since August
 *   was told to check whether their vault sits in Dropbox.
 * - **Signing out dropped the linked vault off the screen.** Nothing about the
 *   link was undone by a session ending, and the one thing worth seeing before
 *   pressing Sign in again is which cloud vault you are about to be back on.
 * - **A refused vault listing read as `Up to date`.** The fetch throws, the
 *   screen keeps whatever it had, and with no folders mounted and `vaultHeld`
 *   still false, `vaultSyncWord(true, [], false)` answers up to date. Green dot
 *   over a vault syncing nothing, in the corner of the window as well.
 *
 * So the screen is named once, here, and the markup asks for the name. Plain
 * data, no Obsidian imports, so every one of those cases is pinned in a test.
 * `vaultShare.ts` is the pattern.
 */

/**
 * The five. They are exclusive: at any moment the pane is exactly one of
 * them, and nothing renders that another screen owns.
 */
export type ScreenName =
	/** No account has ever been used here. Nothing to report, one thing to press. */
	| "new"
	/** Signed in, no cloud vault linked yet. The list is the screen. */
	| "choose"
	/** Linked. The state of the sync is the screen. */
	| "linked"
	/** Signed in before, signed out now. */
	| "signedOut"
	/** Signed in, and Knap did not answer. */
	| "unreachable";

export interface ScreenInput {
	/** There is a live session for this server. */
	signedIn: boolean;
	/** An account has been used on this device before, session or not. */
	returning: boolean;
	/** A cloud vault is linked to this local vault. */
	linked: boolean;
	/** The last attempt to list the account's vaults did not come back. */
	unreachable: boolean;
}

/**
 * Signed out comes first, because it is the one a person can act on: a link
 * that survives a session is still worth showing, and it is shown, but the
 * screen is about signing back in.
 *
 * Linked comes before unreachable on purpose. A cloud vault that is already
 * mounted keeps syncing whether or not the account's vault list came back, so
 * a failed listing there is a fetch that failed and not a vault that stopped.
 * Unreachable is the screen only when the list was the screen.
 */
export function screenFor(state: ScreenInput): ScreenName {
	if (!state.signedIn) return state.returning ? "signedOut" : "new";
	if (state.linked) return "linked";
	return state.unreachable ? "unreachable" : "choose";
}

/**
 * The list of things to sort out belongs on exactly one screen: the one with
 * the button that starts the sync next to it.
 *
 * It cannot be acted on before there is an account, and it is an insult to
 * somebody who has been syncing for a month, which is what it was for both.
 */
export function showsChecklist(screen: ScreenName): boolean {
	return screen === "choose";
}

/**
 * Whether the state of the vault is worth reporting at all.
 *
 * A device with no account has no vault to report on, and the four words in
 * `syncStatus.ts` are all about a vault that has one. Rendering the word here
 * is what put a red dot on an install where nothing had gone wrong.
 */
export function showsVaultState(screen: ScreenName): boolean {
	return screen !== "new" && screen !== "unreachable";
}

/**
 * Whether the linked cloud vault is named on this screen.
 *
 * Everywhere it is known, including signed out. Not on `choose`, where the
 * list already says nothing is linked, and not on `new`, where nothing is.
 */
export function showsLinkedVault(screen: ScreenName): boolean {
	return screen === "linked" || screen === "signedOut";
}

/** The way in, and it says the same thing whether or not this is the first time. */
export const NOT_SYNCING_TITLE = "Not syncing";

export const NOT_SYNCING_NOTE = "Sign in to sync this vault with Knap.";

/**
 * What Knap being unreachable is called on screen.
 *
 * A state rather than an event, because the screen keeps saying it until
 * something changes. The line under it is the only fact somebody wants from a
 * failure they cannot fix: whether anything moved.
 */
export const UNREACHABLE_TITLE = "Knap cannot be reached";

export const UNREACHABLE_NOTE = "Nothing on this device has changed.";

export const TRY_AGAIN_LABEL = "Try again";

/** The label on the row that holds the linked cloud vault. */
export const VAULT_ROW_LABEL = "Vault";

/** The label on the row that holds the account and the way out of it. */
export const ACCOUNT_ROW_LABEL = "Account";

/**
 * The privacy line, which is the half of the old paragraph that was
 * load-bearing.
 *
 * ADR-0003 is a promise about what never leaves the machine, and forty-five
 * words listing what does leave it buried the promise in the middle. What a
 * person checks for is the second half, so the second half is the line.
 */
export const FAULT_REPORTING_LABEL = "Send error reports";

export const FAULT_REPORTING_NOTE =
	"Never a note, a file name, or anything that identifies you.";
