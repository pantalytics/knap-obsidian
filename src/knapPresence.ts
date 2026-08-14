"use strict";

import type { Awareness } from "y-protocols/awareness";

/**
 * What this device is doing with a cloud vault *right now*.
 *
 * The other half of `knapMeta.ts`'s device row, and the two do different jobs
 * (ADR-0064 in the admin repository). The row in `knap_devices_v0` is durable:
 * it survives a shut laptop, which is what keeps a device on Knap's page at
 * all, and it is rewritten at most hourly because every write is an update
 * every peer on the vault receives. It therefore cannot carry what a device
 * owes, which changes every few seconds: an hour-old count would look current.
 *
 * This is the live half, and it rides **awareness** on the provider the folder
 * already holds open. Two properties make it the right channel, both measured
 * before anything was built on them (`scripts/spikes/vault_presence/` in the
 * admin repository): nothing here enters the document, so a device restating
 * itself costs the vault nothing durable, and the server withdraws a client's
 * awareness within a second of its socket closing, so a page can grey a device
 * out because it is gone rather than because a timer ran out.
 *
 * Knap cannot work any of this out for itself. It sees the folder document and
 * the copy it keeps, and never the files on this machine, so whether a local
 * vault is level with its cloud vault is a claim only this side can make.
 */

/**
 * The awareness field that is ours.
 *
 * Upstream already sets `user` (`HasProvider.ts`), which names the account and
 * is the same value on every machine one person owns. It answers *somebody of
 * mine is connected* and never *which*, which is why this carries the install
 * id: it is the same key `knap_devices_v0` uses, and it is what joins the live
 * half to the durable one.
 */
export const KNAP_AWARENESS_FIELD = "knap";

/** What a device is doing, in the four words both screens share. */
export type DeviceState = "syncing" | "up_to_date" | "paused" | "signed_out";

/** What one device says about one cloud vault. */
export interface DevicePresence {
	state: DeviceState;
	/** Notes here that the cloud vault does not have yet. */
	up: number;
	/** Notes in the cloud vault that are not here yet. */
	down: number;
	/** What this vault is called here, for a device whose row has not landed. */
	vault: string;
	/** "desktop" or "mobile", as specific as Obsidian will say. */
	platform: string;
}

/** Say it, on the socket this folder is already holding. */
export function publishPresence(
	awareness: Awareness,
	installId: string,
	presence: DevicePresence,
): void {
	const install = installId.trim();
	if (!install) return;
	awareness.setLocalStateField(KNAP_AWARENESS_FIELD, {
		install,
		state: presence.state,
		up: Math.max(0, Math.round(presence.up)),
		down: Math.max(0, Math.round(presence.down)),
		vault: presence.vault.trim(),
		platform: presence.platform,
	});
}

/**
 * Stop claiming to be here, without waiting for the socket to notice.
 *
 * Politeness rather than correctness: the server withdraws this on a close
 * anyway. The durable row deliberately stays, because a device that still
 * syncs this vault is still one of its devices; `forgetKnapDevice` is what
 * takes that out, and only when this device actually stops syncing.
 */
export function withdrawPresence(awareness: Awareness): void {
	awareness.setLocalStateField(KNAP_AWARENESS_FIELD, null);
}

/**
 * What this device owes a cloud vault, from the sync queue for that folder.
 *
 * Two directions rather than one total, because they ask different things of a
 * person: notes waiting to go up need this machine left open, notes waiting to
 * come down clear themselves while Obsidian is running. A single number would
 * hide the only part somebody can act on.
 */
export function owed(group?: {
	syncs: number;
	downloads: number;
	completedSyncs: number;
	completedDownloads: number;
}): { up: number; down: number } {
	if (!group) return { up: 0, down: 0 };
	return {
		up: Math.max(0, group.syncs - group.completedSyncs),
		down: Math.max(0, group.downloads - group.completedDownloads),
	};
}

/**
 * The word for a device, from how it is placed and what it owes.
 *
 * Mirrors `syncStatus.syncWord` and takes the counts as well, so a folder with
 * nothing queued reads as up to date rather than as busy. Signed out and
 * paused come first: neither is a state the counts can argue with.
 *
 * The counts travel beside the word rather than only the word, because Knap
 * reports a device claiming to be finished while owing notes as still syncing,
 * and it can only do that if it has the numbers.
 */
export function stateFor(input: {
	signedIn: boolean;
	paused: boolean;
	up: number;
	down: number;
}): DeviceState {
	if (!input.signedIn) return "signed_out";
	if (input.paused) return "paused";
	if (input.up > 0 || input.down > 0) return "syncing";
	return "up_to_date";
}
