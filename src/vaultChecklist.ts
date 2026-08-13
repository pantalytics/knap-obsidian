"use strict";

/**
 * What gets checked before this vault starts syncing with Knap, as a list
 * somebody can read.
 *
 * `vaultHazards.ts` already knows all of this. What it does not do is show its
 * working: it hands back the one warning worth saying and stays quiet about
 * everything it looked at and found fine. That is the right shape for a screen
 * about a vault that is already syncing, and the wrong one for the moment
 * somebody puts their notes in the cloud, where the useful thing is the whole
 * list with ticks against it.
 *
 * So this is the same three questions, asked out loud:
 *
 * 1. Is Obsidian Sync on in this vault?
 * 2. Is another sync plugin on?
 * 3. Does the vault folder sit inside a cloud drive?
 *
 * One vault gets one sync system, which is the rule behind all three. A check
 * that fails is not automatically a refusal: only a plugin holding the same
 * collaborative documents open blocks, because that one is two writers on one
 * note rather than two copies of a file. The rest say what is wrong and let
 * somebody carry on, which is the line `vaultHazards.ts` already draws and
 * this file does not move.
 *
 * Pure over a `VaultReader`, no Obsidian imports, so the whole list can be
 * driven from a test.
 */

import {
	cloudFolder,
	cloudFolderHazard,
	coreSyncPlugins,
	otherSyncPlugins,
	syncPluginHazard,
	type VaultReader,
} from "./vaultHazards";

export type CheckKind = "obsidian-sync" | "other-sync-plugin" | "cloud-folder";

export interface Check {
	kind: CheckKind;
	/** What was checked, written as the answer somebody wants to see. */
	label: string;
	/** Whether it is that way. */
	ok: boolean;
	/** Whether failing it stops the vault. Meaningless when `ok`. */
	blocking: boolean;
	/** What is wrong and what to do about it, a paragraph a line. */
	lines: readonly string[];
}

/**
 * The three checks, in the order they are worth reading.
 *
 * Obsidian Sync first because it is the likeliest of the three and the one
 * Obsidian's own help warns about, then the plugins, then the folder, which is
 * a guess off a path and the softest of the three.
 *
 * A list that cannot be read comes back as nothing found rather than as a
 * failure: `loadedPlugins` is empty when Obsidian will not say, and holding a
 * vault back on a question we could not ask is the worse mistake.
 */
export function vaultChecklist(vault: VaultReader): Check[] {
	const core = coreSyncPlugins(vault.loadedCorePlugins);
	const others = otherSyncPlugins(vault.loadedPlugins);
	const drive = cloudFolder(vault.basePath);

	const coreHazard = syncPluginHazard(core, false);
	const othersHazard = syncPluginHazard(others, false);
	const driveHazard = cloudFolderHazard(drive, vault.onPhone);

	return [
		{
			kind: "obsidian-sync",
			label: core.length
				? "Obsidian Sync is syncing this vault"
				: "Obsidian Sync is off in this vault",
			ok: core.length === 0,
			blocking: Boolean(coreHazard?.blocking),
			lines: coreHazard?.lines ?? [],
		},
		{
			kind: "other-sync-plugin",
			label: others.length
				? `${namesOf(others)} ${others.length > 1 ? "are" : "is"} syncing this vault`
				: "No other sync plugin is running here",
			ok: others.length === 0,
			blocking: Boolean(othersHazard?.blocking),
			lines: othersHazard?.lines ?? [],
		},
		{
			kind: "cloud-folder",
			label: drive
				? `This vault sits in ${drive}`
				: "The vault folder is not in a cloud drive",
			ok: !drive,
			blocking: Boolean(driveHazard?.blocking),
			lines: driveHazard?.lines ?? [],
		},
	];
}

/** The check that stops it, if one does. */
export function blockedBy(checks: readonly Check[]): Check | undefined {
	return checks.find((check) => !check.ok && check.blocking);
}

/** Whether anything at all came back wrong, blocking or not. */
export function anythingWrong(checks: readonly Check[]): boolean {
	return checks.some((check) => !check.ok);
}

/** The heading over the list. */
export const CHECKLIST_TITLE = "Before this vault syncs";

/**
 * What the list is for, under the heading.
 *
 * It says the rule rather than listing the three checks again, because the
 * rows underneath are the list and repeating them is how nobody reads either.
 */
export const CHECKLIST_NOTE =
	"One vault syncs with one system. Knap looks for the others before it starts.";

/** What to say when all three came back the way they should. */
export const CHECKLIST_ALL_CLEAR = "Nothing else is syncing this vault.";

/**
 * What to say when something is wrong but nothing is stopping it.
 *
 * A file-level sync and a vault in a cloud drive both cost somebody conflicted
 * copies rather than lost notes, and turning off a sync they pay for is a
 * migration they schedule. So the button stays, and the sentence is honest
 * about what pressing it buys.
 */
export const CHECKLIST_CARRY_ON =
	"Knap can start anyway. Two systems on one vault is how a note comes back as a conflicted copy, so it is worth sorting out first.";

/**
 * What to say when it is stopped.
 *
 * The only thing that gets here is a plugin holding the same documents open,
 * which is two writers on one note and one of them losing. It names no fix
 * because the row above it already carries the instruction.
 */
export const CHECKLIST_BLOCKED =
	"Knap will not start while that is on. Turn it off, then check again.";

/** The button that runs the three questions once more. */
export const CHECK_AGAIN_LABEL = "Check again";

/** The button that goes back to the vaults without starting anything. */
export const CHECKLIST_BACK_LABEL = "Back to the list";

/** "Relay by System 3", "Git and Remotely Save". */
function namesOf(plugins: readonly { name: string }[]): string {
	const names = plugins.map((plugin) => plugin.name);
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
