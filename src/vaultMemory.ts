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
 * - `nothing`: the two agree, or there is nothing to agree about.
 */
export type VaultRecall =
	| { action: "mount"; vault: RememberedVault }
	| { action: "remember"; id: string }
	| { action: "nothing" };

/** The remembered id, or nothing if this vault has never been pointed at one. */
export function rememberedVaultId(
	remembered: RememberedVault | undefined,
): string | undefined {
	const id = remembered?.id;
	return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Reconcile the memory against what is actually mounted.
 *
 * Two rules, and the second one is the one worth stating out loud.
 *
 * **What is mounted wins.** A share that is mounted is a share that is
 * syncing: it holds a document open, it has notes going up and down it, and
 * whatever put it there knew something this file does not. So a mounted vault
 * share that disagrees with the memory rewrites the memory rather than being
 * torn down to match it. There is no case where this file stops a vault from
 * syncing.
 *
 * **Folder shares are left alone.** An install still syncing folders from an
 * older build cannot hold a vault share beside them -- `SharedFolder._new`
 * refuses it in both directions -- so mounting one here would throw, and the
 * screen that offers to take the folders off is where that case is handled.
 * The memory keeps whatever it holds and waits.
 */
export function recallVault(
	remembered: RememberedVault | undefined,
	mounted: MountedShare[],
): VaultRecall {
	const mountedVault = mounted.find((share) => share.isVaultScope);
	const rememberedId = rememberedVaultId(remembered);

	if (mountedVault) {
		if (mountedVault.guid === rememberedId) return { action: "nothing" };
		return { action: "remember", id: mountedVault.guid };
	}

	if (!rememberedId) return { action: "nothing" };
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
