"use strict";

/**
 * Which vault on Knap this device syncs with, and how it gets picked.
 *
 * The account is the unit of access: one Knap account reaches zero, one or
 * many vaults in the cloud, and each of those can be open on any number of
 * devices, in any number of local vaults. So signing in cannot work out on its
 * own which one is meant, and it no longer tries. **It lists what the account
 * reaches and waits to be told**, which is the only answer that is right in
 * every one of those cases.
 *
 * This replaces matching on the vault's name. That rule was cheap and it was
 * wrong in both directions: two vaults called the same thing on one account
 * joined each other silently, and a vault renamed in Obsidian, or typed by
 * hand into a fresh vault on a phone, started a second one nobody asked for.
 * Picking from a list makes both impossible, and it is also the only way to
 * reach a vault somebody shared with you, which by definition is not called
 * what your local vault is called.
 *
 * What is left of the old shape is deliberate: a vault is still one share
 * (ADR-0043), the whole vault still syncs, and nothing here offers a way to
 * sync part of one. The choice is which vault, never how much of it.
 *
 * Measured against the running control plane on 2026-08-11 and read again at
 * `3524558` on 2026-08-13: `GET /v1/shares` returns the shares the caller owns
 * **and** the ones they are a member of, so it is already the list this file
 * wants. `ShareCreate.path` is a string with `minLength: 1`, so a new vault
 * cannot be made with an empty name, and `kind` defaults to "doc" and has to
 * be set to "folder".
 */

/** The share fields this file needs. The real one carries a good deal more. */
export interface ShareLike {
	id: string;
	kind: "doc" | "folder";
	path: string;
	/** When the vault was made on Knap. The one fact worth previewing. */
	created_at?: string;
	/** False when somebody else owns it and this account is a member of it. */
	is_owner?: boolean;
}

export type VaultShareDecision =
	| { action: "choose"; vaults: ShareLike[] }
	| { action: "already-syncing"; vault?: ShareLike }
	| { action: "replace-folders"; count: number };

/**
 * What signing in should do about the vault.
 *
 * - Already syncing: nothing to do, and no second call. This comes first
 *   because it is what is happening. The share it is syncing with comes back
 *   alongside, so the screen can name it rather than naming the local folder.
 * - Folder shares from an older build: say so and wait to be told. They cannot
 *   coexist with a vault share (`SharedFolder._new` refuses it in both
 *   directions), so nothing can be joined until they come off, and taking a
 *   share off is destructive enough to ask about first.
 * - Otherwise: hand back the vaults the account reaches, and wait. An empty
 *   list is an ordinary answer rather than an error, and it is what a new
 *   account looks like.
 */
export function decideVaultShare(
	remoteShares: ShareLike[],
	local: {
		/** The share id this vault already syncs with, if it syncs with one. */
		vaultShareId?: string;
		folderShareCount: number;
	},
): VaultShareDecision {
	if (local.vaultShareId) {
		return {
			action: "already-syncing",
			vault: remoteShares.find((share) => share.id === local.vaultShareId),
		};
	}
	if (local.folderShareCount > 0) {
		return { action: "replace-folders", count: local.folderShareCount };
	}
	return { action: "choose", vaults: cloudVaults(remoteShares) };
}

/**
 * The vaults on the list, in the order they are shown.
 *
 * `kind: "doc"` is a single note somebody published and never a vault. What is
 * left is every whole-vault share plus, on an account old enough to have them,
 * the folder shares an older build made: the record cannot tell those apart
 * (ADR-0041) and guessing would put a folder on a list of vaults. They are
 * shown, because a list that quietly drops a row somebody knows they have is
 * worse than one with an extra row on it.
 *
 * By name, so the same account draws the same list on every device, and by id
 * where two carry the same name, because sort order is not the place to be
 * clever about a duplicate somebody meant to make.
 */
export function cloudVaults(remoteShares: ShareLike[]): ShareLike[] {
	return remoteShares
		.filter((share) => share.kind === "folder")
		.sort(
			(a, b) =>
				a.path.localeCompare(b.path, "en", { sensitivity: "base" }) ||
				a.id.localeCompare(b.id),
		);
}

/** One of this vault's shares, as the clean-up needs to see it. */
export interface LocalShare {
	/** The share id on the server, which is also the folder document's id. */
	id: string;
	/** Whether it covers the whole vault or one folder in it. */
	isVaultScope: boolean;
}

/**
 * The folder shares to take off, so a vault can be joined.
 *
 * **It plans from this vault's own shares, never from the account's.** A Knap
 * account can hold vaults this device has nothing to do with and vaults
 * somebody else owns, and neither is this vault's business. Every share this
 * vault syncs has a local record carrying its id, so the local records are the
 * list, and a share nobody here knows about is left where it is.
 *
 * The order is the server first and the local record second, so a refusal
 * stops the run with the two halves still agreeing about what is shared.
 */
export function planFolderCleanup(local: LocalShare[]): string[] {
	return local.filter((share) => !share.isVaultScope).map((share) => share.id);
}

/**
 * The rule the whole of this file turns on, said out loud.
 *
 * It replaces the sentence that said the name was the key, which stopped being
 * true the moment the list arrived. What it says instead is the thing somebody
 * needs on the second device: this is a choice, it was made once, and Obsidian
 * has no opinion about it. Renaming either side changes nothing.
 */
export const VAULT_CHOICE_IS_YOURS =
	"You pick which vault on Knap this one syncs with. The names do not have to match, and renaming either of them does not change the pairing.";

/** The heading over the list, and the line under it. */
export const CHOOSE_A_VAULT = "Pick the vault this device syncs with.";

/**
 * What to say when the account reaches nothing yet.
 *
 * A new account, which is most of them once, and it is not an error: there is
 * one button under this and it is the one to press.
 */
export const NO_VAULTS_YET =
	"Your Knap account has no vaults yet. Start one from the notes already on this device.";

/** What the screen says while it is waiting to be told. */
export const JOIN_HELD_NOTE =
	"Nothing syncs until you pick one. Your notes stay on this device either way.";

/** The row for one vault: the name, and the little Knap will say about it. */
export function vaultRowLines(vault: ShareLike): string[] {
	const lines: string[] = [];
	const made = formatDay(vault.created_at);
	if (made) {
		lines.push(`Added to Knap on ${made}`);
	}
	if (vault.is_owner === false) {
		// Not "shared with you". Share is the control plane's noun and stays
		// off a screen (ADR-0038); what a person needs here is whose vault it
		// is, which is the same fact in the words the rest of Knap uses.
		lines.push("Someone else's vault");
	}
	return lines;
}

/** The button that starts a new one, with the name it will carry. */
export function newVaultLabel(vaultName: string): string {
	return `Start a new vault called ${vaultName}`;
}

/**
 * What starting a new one does, said next to the button.
 *
 * The name comes from Obsidian because there is nowhere else to get one and no
 * screen here worth spending on a text field. It is a name, not a key: nothing
 * matches on it afterwards, which is why renaming the vault later is harmless
 * and why this line does not warn about it.
 */
export function newVaultLine(vaultName: string): string {
	return (
		`It takes its name from this vault in Obsidian, so it will be called ${vaultName} on Knap, ` +
		"and everything here uploads into it."
	);
}

/**
 * What joining an existing vault does to the notes already here, said first.
 *
 * This is the sharp edge of picking rather than matching. Joining pours a
 * vault that is already on Knap into this folder on disk, and if there is
 * anything here it ends up holding both. Obsidian's own answer is to start
 * from an empty vault, so that is what the sentence says, and it says it with
 * the two numbers that make it concrete.
 *
 * One paragraph, because `confirmDialog` renders the message as one.
 */
export function joinConfirmation(vaultName: string, localFiles: number): string {
	const here =
		localFiles === 1
			? "The one file already in this vault stays"
			: `The ${localFiles} files already in this vault stay`;
	return (
		`${vaultName} downloads into this vault in Obsidian, and everything here uploads into ${vaultName}. ` +
		`${here} where they are, and end up on Knap too. ` +
		"If you meant to keep them apart, make an empty vault in Obsidian and join from there instead."
	);
}

/** The button that joins it, with the name on it so nobody presses it blind. */
export function joinButtonLabel(vaultName: string): string {
	return `Sync with ${vaultName}`;
}

/** The button that starts the clean-up, on the one screen that offers it. */
export const REPLACE_FOLDERS_LABEL = "Sync the whole vault";

/**
 * What to say to a vault that still syncs folders.
 *
 * This is the only place folders are still named on a screen, and it is here
 * to be grown out of: an older build let somebody pick them, and nothing can
 * be joined until they are gone.
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
 * already removed stays removed and nothing is joined on top of a folder that
 * is still there. Pressing the button again picks up from where it stopped.
 */
export function replaceFoldersFailedLine(reason: string): string {
	return (
		`Knap could not stop syncing a folder: ${reason}. ` +
		"Nothing else has changed. Try again in a moment."
	);
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
 * A bare second device reads as a failed sync to anybody expecting their setup
 * to arrive with the notes, and that question outlives the upload that
 * prompts it.
 */
export const VAULT_SCOPE_NOTE =
	"Your notes sync. Settings, themes and plugins stay on the device they are installed on.";
