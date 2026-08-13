"use strict";

/**
 * What Sync vault says, before it starts and after it has.
 *
 * It lives here rather than inline in `main.ts` because the two notices used
 * to contradict each other. Pressing Sync vault said *Syncing all shares...*
 * on the way in and *No shares to sync* a second later on the way out, one
 * above the other in the corner, over a vault that was syncing perfectly
 * well. Two things went wrong and both are fixed here:
 *
 * - The opening notice was unconditional. It announced work before anything
 *   had counted whether there was any, so it could only agree with the
 *   closing one by luck. Nothing is announced now until the work is counted,
 *   which is why this file returns a plan rather than a string.
 * - The count came off a listing fetched from the control plane, and
 *   `getAllShares` turns a failed listing into an empty one. A refused token
 *   or a rate-limited minute read exactly like a vault with nothing in it.
 *   What this device syncs is the folders it holds, which is also what the
 *   mark in the corner of the window reads, so that is what is counted.
 *
 * The words are `syncStatus.ts`'s, which mirrors `status.py` in the admin
 * repository. A notice that invents its own vocabulary for the same fact is
 * how somebody ends up believing they are watching two different things.
 * Four words reach a person here (ADR-0038): vault, folder, sync and MCP.
 */

import { PAUSED, SIGNED_OUT, SYNCING, syncInstruction } from "./syncStatus";

/** What this device has to sync, counted before anything is told to start. */
export interface VaultSyncWork {
	/** Whether Knap has a client for this vault at all. */
	connected: boolean;
	/**
	 * Shared folders this device holds and has switched on. A vault is one of
	 * them (ADR-0043); a vault an older build left syncing folders has
	 * several.
	 */
	folders: number;
	/** Folders held but switched off here, which is what Paused means. */
	pausedFolders: number;
	/** Web-published shares, upstream's feature, which this action pushes. */
	webShares: number;
}

/**
 * Whether there is anything to do, and the one thing to say about it.
 *
 * `start` false carries the reason, and it is the only notice that click
 * produces. `start` true carries the opening notice, and `vaultSyncResult`
 * carries the closing one.
 */
export type VaultSyncPlan =
	| { start: false; notice: string }
	| { start: true; notice: string };

export function planVaultSync(work: VaultSyncWork): VaultSyncPlan {
	if (!work.connected) {
		return { start: false, notice: `${SIGNED_OUT}. ${syncInstruction(SIGNED_OUT)}` };
	}
	if (work.folders > 0) {
		return { start: true, notice: "Syncing this vault..." };
	}
	if (work.webShares > 0) {
		// Nothing of this vault syncs, and there are still published files to
		// push. Saying the vault is syncing here would be the old lie with
		// better words on it.
		return { start: true, notice: "Sending your published files..." };
	}
	if (work.pausedFolders > 0) {
		return { start: false, notice: `${PAUSED}. ${syncInstruction(PAUSED)}` };
	}
	return {
		start: false,
		notice: "This vault is not syncing yet. Open Knap in settings to set it up.",
	};
}

/**
 * What happened, said once the work has been handed over.
 *
 * The folders are told to connect and the notes go up behind that, so this
 * says syncing rather than synced: a vault of a few thousand notes is hours
 * of work, and the corner of the window is where it is watched. The web half
 * is awaited, so that half may be counted.
 */
export function vaultSyncResult(work: VaultSyncWork, webSent: number): string {
	const sent = `Sent ${webSent} published ${webSent === 1 ? "file" : "files"}.`;
	if (work.folders > 0) {
		const syncing = `Syncing this vault. ${syncInstruction(SYNCING)}`;
		return webSent > 0 ? `${syncing} ${sent}` : syncing;
	}
	if (webSent > 0) {
		return sent;
	}
	return "Nothing was sent. The published files may no longer be in this vault.";
}
