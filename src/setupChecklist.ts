"use strict";

/**
 * The two things to sort out before a vault starts syncing, said once.
 *
 * This replaces the checks that used to look for them (#41). Both are real,
 * both cost somebody notes, and neither turned out to be answerable from
 * inside the plugin:
 *
 * - **Obsidian Sync reads as on in every vault.** It ships with the app, so
 *   `app.internalPlugins.plugins.sync.enabled` is true whether or not anybody
 *   has a subscription, has ever opened it, or has any vault syncing through
 *   it. Measured on a vault with no Sync subscription at all, 2026-08-14: the
 *   warning fired on a vault where nothing else was syncing anything. A check
 *   that is wrong on the ordinary install is worse than no check, because the
 *   one person who needs it has already been taught the warning means nothing.
 * - **A cloud folder is a guess off a path.** `~/Dropbox-notes/` matched and a
 *   vault in a Dropbox folder mounted somewhere else did not, and on iOS the
 *   vault Obsidian makes for itself is in iCloud Drive to begin with, so the
 *   warning fired on the default setup for the platform where it is hardest
 *   to act on.
 *
 * So the plugin stops guessing and says what to check. A person can see their
 * own Settings screen and their own folders, which is more than this file
 * could ever work out, and a list they read once during setup costs nothing
 * on every start afterwards.
 *
 * Plain data, no Obsidian imports, so the copy can be pinned in a test.
 * `vaultShare.ts` is the pattern.
 */

/** One line of the list. */
export interface ChecklistItem {
	/** The check itself, in the imperative. */
	title: string;
	/** Why it matters, which is what makes somebody bother. */
	detail: string;
}

export const CHECKLIST_TITLE = "Before you start";

export const CHECKLIST: readonly ChecklistItem[] = [
	{
		title: "Only one thing syncs this vault",
		detail:
			"If Obsidian Sync, Relay or another sync plugin is on for this vault, turn it off first. Two of them writing one note means the last write wins and the other version is gone.",
	},
	{
		title: "The vault is not inside iCloud, Dropbox or OneDrive",
		detail:
			"A vault in one of those folders is being copied by two things at once. That is how a note comes back as a conflicted copy, or reads as empty here while the drive is still fetching it.",
	},
	{
		title: "Obsidian stays open until the first copy finishes",
		detail:
			"The first copy sends every note you have, which on a big vault takes a while. Close it and it picks up where it left off.",
	},
];
