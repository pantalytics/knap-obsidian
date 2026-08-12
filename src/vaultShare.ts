"use strict";

/**
 * What a vault syncs: the whole thing, and nothing else on offer.
 *
 * Signing in is the consent for it (ADR-0032) and there is no second answer to
 * give (ADR-0042). A vault is one share, the way a vault is one thing to the
 * person who keeps it, and every question that used to hang off picking
 * folders -- which mode is this device in, does the server agree, what happens
 * to the shares the old mode owned -- stops being a question.
 *
 * What is left here is small on purpose: work out whether this vault already
 * has its share, adopt one if a sibling device made it, and clear up after a
 * build that let somebody pick folders. The decisions are plain functions over
 * the shares that exist, kept apart from the screen that calls them so they
 * can be tested without Obsidian.
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
	/** When the vault was made on Knap. The one fact worth previewing (#42). */
	created_at?: string;
}

export type VaultShareDecision =
	| { action: "create"; path: string }
	| { action: "adopt"; share: ShareLike }
	| { action: "already-syncing" }
	| { action: "replace-folders"; count: number };

/**
 * What signing in should do about the whole vault.
 *
 * - Already syncing whole: nothing to do, and no second call. This comes first
 *   because it is what is happening.
 * - Folder shares from an older build: say so and wait to be told. They cannot
 *   coexist with a vault share (`SharedFolder._new` refuses it in both
 *   directions), so the vault share cannot be made until they come off, and
 *   taking a share off is destructive enough to ask about first.
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
		hasVaultShare: boolean;
		folderShareCount: number;
	},
): VaultShareDecision {
	if (local.hasVaultShare) {
		return { action: "already-syncing" };
	}
	if (local.folderShareCount > 0) {
		return { action: "replace-folders", count: local.folderShareCount };
	}
	const existing = remoteShares.find(
		(share) => share.kind === "folder" && share.path === vaultName,
	);
	if (existing) {
		return { action: "adopt", share: existing };
	}
	return { action: "create", path: vaultName };
}

/** One of this vault's shares, as the clean-up needs to see it. */
export interface LocalShare {
	/** The share id on the server, which is also the folder document's id. */
	id: string;
	/** Whether it covers the whole vault or one folder in it. */
	isVaultScope: boolean;
}

/**
 * The folder shares to take off, so the vault share can be made.
 *
 * **It plans from this vault's own shares, never from the account's.** A relay
 * account can hold shares for a second vault and shares somebody else owns,
 * and neither is this vault's business. Every share this vault syncs has a
 * local record carrying its id, so the local records are the list, and a share
 * nobody here knows about is left where it is.
 *
 * The order is the server first and the local record second, so a refusal
 * stops the run with the two halves still agreeing about what is shared.
 */
export function planFolderCleanup(local: LocalShare[]): string[] {
	return local.filter((share) => !share.isVaultScope).map((share) => share.id);
}


/**
 * The rule the whole of `decideVaultShare` turns on, said out loud (#42).
 *
 * The name is the key a device joins on, and until this line existed nothing
 * anywhere said so. One character apart and a second vault appears on Knap
 * with nobody told, which is what happens to somebody who tidies a folder name
 * on one device, and it is also what a person setting up on a phone risks
 * every time, because iOS makes them type the name by hand into a fresh vault
 * in Obsidian's own folder.
 *
 * It reads as a fact rather than a warning because it is one, and because it
 * is also the handle: renaming a vault on purpose is the only way to end up
 * somewhere other than where the name points, and somebody moving off a vault
 * that has gone bad needs to know that.
 */
export const VAULT_NAME_IS_THE_KEY =
	"Knap matches vaults by name. Another device joins this vault by having a vault with the same name on it. A different name starts a second vault instead.";

/** What Knap will tell you about a vault before you join it. */
export interface JoinPreview {
	/** The name it matched on, which is this vault's name and the share's path. */
	vaultName: string;
	/** When the vault was made on Knap, ISO, from the share record. */
	createdAt?: string;
}

/**
 * What is about to be joined, said before it is joined (#42).
 *
 * **This is everything the control plane will tell us at this moment, and it
 * is less than the issue asked for.** A share record carries an id, a kind, a
 * path, a visibility, an owner and two timestamps. There is no note count in
 * it: the files index is the web publishing artifact list, which is empty on a
 * private vault, so reading a count off it would report 0 notes for a healthy
 * vault of thousands. There is no device count either, anywhere in this
 * plugin's half of the API. So the preview says the name, the rule it matched
 * on and the day the vault was made, and invents neither of the other two.
 *
 * The date is the one that settles it in practice. Somebody adding their
 * second device made the first one this week; somebody who has just typed a
 * name into a phone and hit an eight-month-old vault has hit the wrong one.
 */
export function joinPreviewLines(preview: JoinPreview): string[] {
	const lines = [
		`Knap already has a vault called ${preview.vaultName}, and this device will sync with that one.`,
		`It matched because the vault here is called ${preview.vaultName} too. The name is the only thing Knap matches on.`,
	];
	const made = formatDay(preview.createdAt);
	if (made) {
		lines.push(`It was added to Knap on ${made}.`);
	}
	lines.push(
		"If that is not the vault you meant, rename this vault in Obsidian first, and Knap will start a separate one under the new name.",
	);
	return lines;
}

/** The button that joins it, with the name on it so nobody presses it blind. */
export function joinButtonLabel(vaultName: string): string {
	return `Sync with ${vaultName}`;
}

/** What the screen says while it is waiting to be told to join. */
export const JOIN_HELD_NOTE =
	"Nothing is syncing until you decide which vault this device belongs to.";

/**
 * A new vault beside the ones already there, said when that is what happens.
 *
 * The costly mistake is not creating a vault, it is creating a second one by
 * accident when a first already exists under a name a character away. Naming
 * what the account already has is the cheapest way to catch that, and it costs
 * no extra call: the list was fetched to make the decision.
 */
export function newVaultBesideLine(
	vaultName: string,
	otherNames: readonly string[],
): string | undefined {
	if (otherNames.length === 0) return undefined;
	const shown = otherNames.slice(0, 3);
	const rest = otherNames.length - shown.length;
	const list =
		rest > 0 ? `${shown.join(", ")} and ${rest} more` : joinNames(shown);
	return (
		`Knap already has ${list} on your account, and this vault is called ${vaultName}. ` +
		"The names do not match, so this one starts as a vault of its own."
	);
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

/**
 * "11 August 2026", from whatever the control plane sent.
 *
 * Written out rather than handed to `toLocaleDateString`, so the same date
 * reads the same on every machine and a test can pin it. Anything unparseable
 * gives nothing back and the line is left out, because a date that says
 * "Invalid Date" is worse than no date at all.
 */
function formatDay(iso?: string): string | undefined {
	if (!iso) return undefined;
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return undefined;
	return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/**
 * What a vault is, in the one line the screen keeps.
 *
 * This used to be the second of two lines shown while the first sync ran. The
 * first of them said to leave Obsidian open, twice over: the status row was
 * already saying it, word for word, directly above. A bar and a count say it
 * better than either, so both sentences went and this one stayed.
 *
 * It stayed because it is not about the first sync at all. A bare second device
 * reads as a failed sync to anybody expecting their setup to arrive with the
 * notes, and that question outlives the upload that prompts it.
 */
export const VAULT_SCOPE_NOTE =
	"Your notes sync. Settings, themes and plugins stay on the device they are installed on.";

/** The button that starts the clean-up, on the one screen that offers it. */
export const REPLACE_FOLDERS_LABEL = "Sync the whole vault";

/**
 * What to say to a vault that still syncs folders.
 *
 * This is the only place folders are still named on a screen, and it is here
 * to be grown out of: an older build let somebody pick them, and the vault
 * cannot start syncing whole until they are gone.
 */
export function replaceFoldersLine(count: number): string {
	const folders = count === 1 ? "one folder" : `${count} folders`;
	return (
		`This vault syncs ${folders} rather than the whole thing. ` +
		"Knap syncs whole vaults now, so the folders come off and everything syncs instead."
	);
}

/**
 * What the clean-up costs, said before it happens.
 *
 * It throws shares away and builds a new one, so the vault re-uploads. That is
 * the honest thing to lead with, because the alternative is somebody pressing
 * a button on a Friday and spending the evening watching a first fill. The
 * notes on the device are never touched, and saying so is what stops the
 * sentence above from reading as data loss.
 *
 * One paragraph, because `confirmDialog` renders the message as one.
 */
export function replaceFoldersConfirmation(removing: number): string {
	const folders =
		removing === 1
			? "Your synced folder stops syncing and comes off Knap. "
			: `Your ${removing} synced folders stop syncing and come off Knap. `;
	return (
		folders +
		"The whole vault then uploads from scratch, which takes a while on a big vault. " +
		"Your notes on this device are not touched."
	);
}

/**
 * What to say when a share would not come off Knap.
 *
 * The clean-up stops at the first refusal rather than carrying on, so what was
 * already removed stays removed and the vault share is not made on top of a
 * folder that is still there. Pressing the button again picks up from where it
 * stopped.
 */
export function replaceFoldersFailedLine(reason: string): string {
	return (
		`Knap could not stop syncing a folder: ${reason}. ` +
		"Nothing else has changed. Try again in a moment."
	);
}
