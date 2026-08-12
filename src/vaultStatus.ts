"use strict";

/**
 * What the corner of the window says this vault is doing.
 *
 * The four words are not chosen here. They come from `syncStatus.ts`, which
 * mirrors the admin repository's `status.py` string for string, and this file
 * only does the step in front of them: it turns the shared folders this plugin
 * holds into the three booleans `syncWord` reads. Doing it here rather than in
 * the status bar is what keeps the icon and the Knap screen from
 * describing the same vault two different ways.
 *
 * A vault with nothing shared reads as up to date, and that is deliberate:
 * signing in shares the whole vault, so the gap between the two is a moment
 * long, and the alternative words would each be a lie for longer than it lasts.
 */

import { syncWord, type SyncDot, type SyncWord } from "./syncStatus";

/**
 * Every dot the status bar may be wearing. It is here rather than in
 * `syncStatus.ts` because that file mirrors `status.py` and this list is a
 * detail of painting an icon: what it is for is taking the previous dot off
 * before putting the next one on.
 */
export const SYNC_DOT_NAMES: readonly SyncDot[] = ["ok", "working", "wait", "error"];

/** The two things a shared folder has to say about itself. */
export interface FolderStatus {
	/** Whether this device wants the folder connected at all. */
	shouldConnect: boolean;
	/** Whether its document has caught up with the server. */
	synced: boolean;
}

/**
 * Paused means every folder is off, not merely one of them: a person who
 * disconnected a single folder has not paused their vault. Syncing means a
 * folder that wants to be connected has not caught up yet, which covers both
 * the first pass and a reconnect after the laptop was shut.
 */
export function vaultSyncWord(
	signedIn: boolean,
	folders: readonly FolderStatus[],
): SyncWord {
	return syncWord({
		signedIn,
		paused: folders.length > 0 && folders.every((folder) => !folder.shouldConnect),
		syncing: folders.some((folder) => folder.shouldConnect && !folder.synced),
	});
}
