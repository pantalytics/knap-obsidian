"use strict";

/**
 * Syncing the whole vault, which is what signing in gets you.
 *
 * A person who has just signed in has not yet met a share, a folder picker or
 * a scope, and asking them to choose one is asking about a vault they have not
 * seen us handle. So the whole vault goes up, and somebody who wants less
 * unshares it and shares folders instead (ADR-0032).
 *
 * The decision here is a plain function over the shares that exist, kept apart
 * from the screen that calls it so it can be tested without Obsidian.
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

export type VaultShareDecision =
	| { action: "create"; path: string }
	| { action: "adopt"; share: ShareLike }
	| { action: "already-syncing" }
	| { action: "folders-instead"; count: number };

/**
 * What signing in should do about the whole vault.
 *
 * - Nothing shared anywhere: create the share.
 * - A share on the server that matches this vault, and nothing locally: this
 *   is a second device, so adopt it rather than making a second copy of the
 *   same vault. Matching is by name and kind, which is all the server keeps,
 *   so two vaults called the same thing would meet here. Reusing the wrong
 *   share is recoverable and duplicating a whole vault is not, and adopting
 *   is what somebody signing in on a laptop and a phone actually wants.
 * - Already syncing whole: nothing to do, and no second call.
 * - Folder shares already exist: leave them alone. Whole vault and folder
 *   shares are exclusive both ways, enforced in SharedFolder._new, and a
 *   person who set up folders did that on purpose.
 */
export function decideVaultShare(
	vaultName: string,
	remoteShares: ShareLike[],
	local: { hasVaultShare: boolean; folderShareCount: number },
): VaultShareDecision {
	if (local.hasVaultShare) {
		return { action: "already-syncing" };
	}
	if (local.folderShareCount > 0) {
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

/** What to say when folder shares are already set up, so the vault stays as it is. */
export function foldersInsteadLine(count: number): string {
	const folders = count === 1 ? "one folder" : `${count} folders`;
	return (
		`This vault syncs ${folders} rather than the whole thing. ` +
		"The two cannot be combined, so unshare them if you want everything to sync."
	);
}
