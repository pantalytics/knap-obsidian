"use strict";

/**
 * What a vault syncs: everything, or the folders somebody picked.
 *
 * The whole vault is the default and signing in is the consent for it
 * (ADR-0032). A person who has just signed in has not yet met a share, a
 * folder picker or a scope, and asking them to choose one is asking about a
 * vault they have not seen us handle.
 *
 * Leaving that default is a setting on the Synced Vaults screen rather than a
 * sequence of unshares, and that is what this file grew for. The old way out
 * was to unshare the vault by hand and share folders one at a time, which left
 * the two halves free to disagree: the plugin stopped syncing a folder and the
 * share it stopped syncing carried on existing on the server. One toggle owns
 * both sides, so the switch is a single act that either lands or does not.
 *
 * The decisions here are plain functions over the shares that exist, kept
 * apart from the screen that calls them so they can be tested without
 * Obsidian.
 *
 * Measured against the running control plane on 2026-08-11, because the shape
 * of a share is upstream's and not ours: `ShareCreate.path` is a string with
 * `minLength: 1`, so a whole-vault share cannot send an empty path, and `kind`
 * defaults to "doc" and has to be set to "folder". The vault's own name is
 * what goes in the path: it is non-empty, it is what the person calls the
 * thing, and it is what a member list will show them later.
 */

/** The share fields this file needs. The real one carries a good deal more. */
export interface ShareLike {
	id: string;
	kind: "doc" | "folder";
	path: string;
}

/**
 * What this vault syncs. Stored per server in the plugin's own settings and
 * never sent anywhere: the server sees the shares that result, not the
 * preference behind them (ADR-0031).
 */
export type VaultSyncMode = "whole-vault" | "folders";

/** What a vault syncs before anybody says otherwise. */
export const DEFAULT_VAULT_SYNC_MODE: VaultSyncMode = "whole-vault";

export type VaultShareDecision =
	| { action: "create"; path: string }
	| { action: "adopt"; share: ShareLike }
	| { action: "already-syncing" }
	| { action: "folders-instead"; count: number };

/**
 * What signing in should do about the whole vault.
 *
 * - Already syncing whole: nothing to do, and no second call. This comes
 *   first because it is what is happening, whatever the setting says.
 * - Set to individual folders: leave the vault alone, even with nothing
 *   shared yet. That gap is the normal state right after the switch, and a
 *   vault share created into it would undo the thing somebody just asked for.
 * - Folder shares exist but the setting has not caught up: same answer. This
 *   is the second device, where the folders arrive from the server and the
 *   setting is local, so what is shared is what the mode is read from.
 * - Nothing shared anywhere: create the share.
 * - A share on the server that matches this vault, and nothing locally: this
 *   is a second device, so adopt it rather than making a second copy of the
 *   same vault. Matching is by name and kind, which is all the server keeps,
 *   so two vaults called the same thing would meet here. Reusing the wrong
 *   share is recoverable and duplicating a whole vault is not, and adopting
 *   is what somebody signing in on a laptop and a phone actually wants.
 */
export function decideVaultShare(
	vaultName: string,
	remoteShares: ShareLike[],
	local: {
		mode: VaultSyncMode;
		hasVaultShare: boolean;
		folderShareCount: number;
	},
): VaultShareDecision {
	if (local.hasVaultShare) {
		return { action: "already-syncing" };
	}
	if (local.mode === "folders" || local.folderShareCount > 0) {
		return { action: "folders-instead", count: local.folderShareCount };
	}
	const existing = remoteShares.find(
		(share) => share.kind === "folder" && share.path === vaultName,
	);
	if (existing) {
		return { action: "adopt", share: existing };
	}
	return { action: "create", path: vaultName };
}

/** One of this vault's shares, as the switch needs to see it. */
export interface LocalShare {
	/** The share id on the server, which is also the folder document's id. */
	id: string;
	/** Whether it covers the whole vault or one folder in it. */
	isVaultScope: boolean;
}

/** What flipping the setting has to do, in order. */
export interface ModeSwitch {
	/** Shares to remove from the server, and then locally. */
	remove: string[];
	/** Whether the whole-vault share is created once the removals land. */
	createVaultShare: boolean;
}

/**
 * What to remove and what to make, to end up in `next`.
 *
 * **It plans from this vault's own shares, never from the account's.** A
 * relay account can hold shares for a second vault and shares somebody else
 * owns, and neither is this toggle's business. Every share this vault syncs
 * has a local record carrying its id, so the local records are the list, and
 * a share nobody here knows about is left where it is.
 *
 * Both directions delete. Whole vault and folder shares are exclusive in
 * `SharedFolder._new`, in both directions, so there is no state where the old
 * share and the new one exist at once and nothing to keep by leaving it
 * behind.
 */
export function planModeSwitch(
	next: VaultSyncMode,
	local: LocalShare[],
): ModeSwitch {
	if (next === "folders") {
		return {
			remove: local.filter((share) => share.isVaultScope).map((share) => share.id),
			createVaultShare: false,
		};
	}
	return {
		remove: local.filter((share) => !share.isVaultScope).map((share) => share.id),
		createVaultShare: true,
	};
}

/**
 * What to say while the first sync runs.
 *
 * The second line is not a detail. A bare second device reads as a failed sync
 * to anybody expecting their setup to arrive with the notes, and this is the
 * only moment they are looking at the screen.
 */
export const FIRST_SYNC_LINES = [
	"The whole vault is on its way up. Leave Obsidian open until it finishes, and it picks up where it left off if you close it.",
	"Your notes, all of them. Not your settings, themes or plugins: those stay on the device they are installed on.",
] as const;

/** The setting's own label and the line under it. */
export const FOLDERS_TOGGLE_LABEL = "Sync individual folders";

export function foldersToggleHint(mode: VaultSyncMode): string {
	return mode === "folders"
		? "Only the folders you pick sync. Right-click a folder in the file explorer to sync it."
		: "Everything in this vault syncs. Turn this on to pick folders instead.";
}

/** What to say when the setting is on and no folder has been picked yet. */
export function foldersInsteadLine(count: number): string {
	if (count === 0) {
		return (
			"Nothing is syncing yet. Right-click a folder in the file explorer to sync it, " +
			"or turn the setting off to sync the whole vault."
		);
	}
	const folders = count === 1 ? "one folder" : `${count} folders`;
	return (
		`This vault syncs ${folders} rather than the whole thing. ` +
		"The two cannot be combined, so turn the setting off if you want everything to sync."
	);
}

/**
 * What the switch costs, said before it happens.
 *
 * Both directions throw away shares and build new ones, so both re-upload.
 * That is the honest thing to lead with, because the alternative is somebody
 * flipping a toggle on a Friday and spending the evening watching a first
 * fill. The notes on the device are never touched, and saying so is what
 * stops the sentence above from reading as data loss.
 *
 * One paragraph, because `confirmDialog` renders the message as one.
 */
export function switchConfirmation(
	next: VaultSyncMode,
	removing: number,
): string {
	if (next === "folders") {
		const vault =
			removing > 0 ? "The whole vault stops syncing and comes off Knap. " : "";
		return (
			vault +
			"Every folder you sync after this uploads from scratch, which takes a while " +
			"on a big vault. Your notes on this device are not touched."
		);
	}
	const folders =
		removing === 1
			? "Your synced folder stops syncing and comes off Knap. "
			: removing > 1
				? `Your ${removing} synced folders stop syncing and come off Knap. `
				: "";
	return (
		folders +
		"The whole vault then uploads from scratch, which takes a while on a big vault. " +
		"Your notes on this device are not touched."
	);
}

/** What to say once it has landed. */
export function switchedNotice(next: VaultSyncMode): string {
	return next === "folders"
		? "Individual folders is on. Nothing syncs until you pick a folder."
		: "The whole vault is syncing.";
}

/**
 * What to say when a share would not come off Knap.
 *
 * The switch stops at the first refusal rather than carrying on, because
 * finishing it would leave the setting saying one thing and the server doing
 * another, which is the failure this toggle exists to end. What was already
 * removed stays removed, so the line says the setting did not move rather than
 * that nothing happened: with several folders to remove, something may well
 * have. Pressing the toggle again picks up from there.
 */
export function switchFailedLine(next: VaultSyncMode, reason: string): string {
	const target = next === "folders" ? "the whole vault" : "a folder";
	return (
		`Knap could not stop syncing ${target}: ${reason}. ` +
		"The setting has not changed. Try again in a moment."
	);
}
