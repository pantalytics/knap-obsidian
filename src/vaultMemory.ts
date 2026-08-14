"use strict";

/**
 * Which cloud vault this device was told to sync, written down on its own.
 *
 * Picking a cloud vault is the one thing about syncing that only a person can
 * answer (ADR-0055, and the reasoning is in `vaultShare.ts`). Everything else
 * on this side is machinery: the share record under `sharedFolders` carries a
 * guid, a path, a scope, a relay id and a bag of sync flags, and half a dozen
 * code paths rewrite it as the vault runs. The answer to *which vault* is one
 * short fact somebody supplied once, and it does not belong in the same place
 * as the machinery that keeps being rewritten.
 *
 * So it is kept twice, deliberately. `sharedFolders` stays the working record
 * -- it is what mounts, connects and syncs -- and `vault` beside it is the
 * memory: the id of the cloud vault somebody pointed this one at, and nothing
 * else that anything is allowed to derive. When the two disagree, this file
 * says which way the disagreement is resolved, and the answer is never "ask
 * again". A person is asked once. After that the plugin's job is to remember.
 *
 * The reason it needed writing down twice is #64: a BRAT update disables the
 * plugin and enables it again while Obsidian is running, and coming back up
 * the vault share was sometimes not mounted -- the record dropped by a load
 * that skipped it, or rewritten by the control-plane pass into a folder share
 * at a path that does not exist here. The screen reads the mounted shares, saw
 * none covering the vault, and did the only thing it knows how to do with that:
 * show the list and wait to be told. Which is correct behaviour on a question
 * that has never been answered, and wrong on every update after the first.
 *
 * Pure functions, no Obsidian imports, so the reconciling can be tested
 * directly. `vaultShare.ts` and `vaultScope.ts` are the pattern.
 */

import { shareScopeOf, type ShareScope } from "./vaultScope";

/**
 * The remembered choice, as it sits in settings.
 *
 * Every field is optional because this is read through `NamespacedSettings`,
 * which hands back an empty object for a key nothing has written yet. An
 * install that has never picked a vault and one that picked one and lost the
 * record are the same shape here, and `id` is what tells them apart.
 */
export interface RememberedVault {
	/** The share id on Knap. The only field anything acts on. */
	id?: string;
	/**
	 * What the cloud vault was called the day it was picked.
	 *
	 * Kept for the log and for a person reading their own `data.json`, and
	 * never matched on: a vault renamed on Knap is the same vault, which is
	 * the whole reason picking replaced matching on the name.
	 */
	name?: string;
	/** Which server it lives on, so a remount does not have to assume. */
	serverId?: string;
	/**
	 * Which local vault this is: Obsidian's own `appId` for this vault on this
	 * machine.
	 *
	 * Nothing on this side reads it. It is here because this record is one end
	 * of a connection between a cloud vault and a local vault, and `appId` is
	 * already the key the other end uses -- it is what `stampKnapDevice` writes
	 * into the vault's document so Knap's page can list the local vaults behind
	 * one cloud vault (1.12.0). Writing it down here as well means the local
	 * half of that pair is a fact on disk rather than something inferred from
	 * whichever device connected last.
	 */
	localId?: string;
}

/** One of this vault's shares, as the reconciling needs to see it. */
export interface MountedShare {
	guid: string;
	isVaultScope: boolean;
}

/**
 * What to do about the difference between what is remembered and what is
 * mounted.
 *
 * - `mount`: a vault is remembered and nothing here covers the vault. Put it
 *   back, without asking and without a request to Knap. This is the case #64
 *   is about.
 * - `remember`: a vault share is mounted and nothing was written down. Write
 *   it down. This is every install that picked its vault before this release,
 *   and it is why the memory does not start empty for them.
 * - `forget`: the link on disk belongs to a different local vault. Drop it and
 *   let the screen ask, rather than syncing somebody else's answer (#71).
 * - `nothing`: the two agree, or there is nothing to agree about.
 */
export type VaultRecall =
	| { action: "mount"; vault: RememberedVault }
	| { action: "remember"; id: string }
	| { action: "forget" }
	| { action: "nothing" };

/** The remembered id, or nothing if this vault has never been pointed at one. */
export function rememberedVaultId(
	remembered: RememberedVault | undefined,
): string | undefined {
	const id = remembered?.id;
	return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Whether a remembered link was written by the local vault reading it.
 *
 * `localId` is Obsidian's `appId`, which is per vault per machine, so this is
 * the whole of what tells one local vault's link from another's. It was
 * written down from the first release that had a memory at all and nothing
 * read it, which is how #71 happened: a settings file naming one cloud vault's
 * id under another's name was restored without anything objecting.
 *
 * A record with no `localId` predates nothing -- every release that wrote the
 * memory wrote the field -- but `NamespacedSettings` hands back partial
 * records, and a link that cannot say where it came from is treated as this
 * vault's rather than thrown away. Refusing it would ask somebody the one
 * question this file exists to stop asking, on the strength of a missing
 * field.
 */
export function linkBelongsHere(
	remembered: RememberedVault | undefined,
	appId: string | undefined,
): boolean {
	const localId = remembered?.localId;
	if (typeof localId !== "string" || localId === "") return true;
	if (typeof appId !== "string" || appId === "") return true;
	return localId === appId;
}

/**
 * Reconcile the link against what is actually mounted.
 *
 * Three rules now, and the third is what #71 cost.
 *
 * **What is mounted wins.** A share that is mounted is a share that is
 * syncing: it holds a document open, it has notes going up and down it, and
 * whatever put it there knew something this file does not. So a mounted vault
 * share that disagrees with the link rewrites the link rather than being torn
 * down to match it. There is no case where this file stops a vault from
 * syncing.
 *
 * **Folder shares are left alone.** An install still syncing folders from an
 * older build cannot hold a vault share beside them -- `SharedFolder._new`
 * refuses it in both directions -- so mounting one here would throw, and the
 * screen that offers to take the folders off is where that case is handled.
 * The link keeps whatever it holds and waits.
 *
 * **A link belonging to a different local vault is dropped, never mounted.**
 * This is the one that was missing. Mounting it is how one local vault ends up
 * syncing another's cloud vault, and the person is asked instead, which is the
 * honest answer to a question whose recorded answer is somebody else's.
 */
export function recallVault(
	remembered: RememberedVault | undefined,
	mounted: MountedShare[],
	appId?: string,
): VaultRecall {
	const mountedVault = mounted.find((share) => share.isVaultScope);
	const rememberedId = rememberedVaultId(remembered);
	const belongsHere = linkBelongsHere(remembered, appId);

	if (mountedVault) {
		if (mountedVault.guid === rememberedId && belongsHere) {
			return { action: "nothing" };
		}
		return { action: "remember", id: mountedVault.guid };
	}

	if (!rememberedId) return { action: "nothing" };
	if (!belongsHere) return { action: "forget" };
	if (mounted.length > 0) return { action: "nothing" };

	return {
		action: "mount",
		vault: {
			id: rememberedId,
			name: remembered?.name,
			serverId: remembered?.serverId,
			localId: remembered?.localId,
		},
	};
}

/** A stored share record, as reading the link out of settings needs to see it. */
export interface StoredShare {
	guid: string;
	path?: string;
	scope?: ShareScope;
}

/**
 * What the stored rows say the link is.
 *
 * - `one`: exactly one row covers the vault. The ordinary case.
 * - `none`: nothing covers the vault. Either folder shares, or a fresh install.
 * - `conflict`: more than one row covers the vault, which is #71 on disk.
 */
export type StoredLink =
	| { link: "one"; guid: string }
	| { link: "none" }
	| { link: "conflict"; guids: string[] };

/**
 * Read the link off the stored rows, and refuse to guess.
 *
 * `SharedFolders._load` used to deduplicate these by path and keep the first,
 * which decided which cloud vault a local vault syncs by array order in a
 * settings file. Every row at the vault root is a vault share --
 * `shareScopeOf` infers that from the path for records written before 1.12.4 --
 * so an install that answered the sign-in screen more than once has several,
 * and picking one silently is how it stayed invisible for as long as it did.
 *
 * More than one is a fault to report, not a list to choose from. Mounting none
 * of them leaves the vault not syncing, which is visible in the corner of the
 * window within seconds and puts the question in front of somebody who can
 * answer it.
 */
export function storedLink(rows: StoredShare[]): StoredLink {
	const vaultRows = rows.filter((row) => shareScopeOf(row) === "vault");
	if (vaultRows.length === 0) return { link: "none" };
	if (vaultRows.length === 1) return { link: "one", guid: vaultRows[0].guid };
	return { link: "conflict", guids: vaultRows.map((row) => row.guid) };
}
