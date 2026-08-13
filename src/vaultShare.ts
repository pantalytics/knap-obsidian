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
 * The words are the panel's, and since ADR-0055 that includes the pair this
 * file is about: the **local vault** is the one Obsidian has open, the **cloud
 * vault** is the one on Knap, and picking is one being pointed at the other.
 * Both halves are in view in most sentences here, which is exactly when the
 * qualifier is called for. Where only one of them is, it says plain vault.
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
 * The heading over the list, and the whole of what it says.
 *
 * It is a label rather than an instruction. The rows underneath are vaults and
 * each one carries a button that says what pressing it does, so a sentence
 * telling somebody to pick one is a caption on a thing that already explains
 * itself.
 */
export const CHOOSE_A_VAULT = "Cloud vaults";

/**
 * What to say when the account reaches nothing yet.
 *
 * The one case where a sentence earns its place: an empty list looks like a
 * screen that failed to load, and the button under it needs a reason to be
 * pressed.
 */
export const NO_VAULTS_YET = "No cloud vaults yet.";

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

/**
 * The button that starts a new one.
 *
 * It does not name the vault it is about to make. The name comes from this
 * local vault, which is the word at the top of the window somebody is looking
 * at, and putting it in a button label spends a line on a fact already on the
 * screen.
 */
export const NEW_VAULT_LABEL = "Create new";

/**
 * What joining an existing vault does to the notes already here, said first.
 *
 * This is the sharp edge of picking rather than matching. Joining pours a
 * vault that is already on Knap into this folder on disk, and if there is
 * anything here it ends up holding both. Obsidian's own answer is to start
 * from an empty vault, so that is what the sentence says, and it says it with
 * the number that makes it concrete.
 *
 * The outcome comes first, in four words, because that is the decision being
 * made: everything, in both vaults. The two directions under it are what it
 * means, not a second telling of it. An earlier draft said the upload twice,
 * once as *everything here uploads* and again as *stays where it is, and ends
 * up on Knap too*, and spent the vault's name twice on a dialog where the name
 * can be forty characters of date and initials.
 *
 * One paragraph, because `confirmDialog` renders the message as one.
 */
export function joinConfirmation(vaultName: string, localFiles: number): string {
	// Grouped, the way syncStatus writes its counts: a vault holds thousands of
	// files, and 2933 is a number somebody has to read twice.
	const here =
		localFiles === 1
			? "the one file already here uploads"
			: `the ${localFiles.toLocaleString("en-US")} files already here upload`;
	return (
		`Both end up with everything: ${vaultName} downloads into this local vault, and ${here} into it. ` +
		"To keep them apart, sync from an empty vault in Obsidian instead."
	);
}

/**
 * The button on a row.
 *
 * One word. The row it sits in carries the vault's name a centimetre to the
 * left, so repeating it in the button is the same string twice on one line.
 */
export const JOIN_LABEL = "Sync";

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
