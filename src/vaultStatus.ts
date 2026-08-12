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

import {
	SYNCING,
	syncCounts,
	syncDot,
	syncProgress,
	syncWord,
	type SyncDot,
	type SyncWord,
} from "./syncStatus";

/**
 * Every dot the status bar may be wearing. It is here rather than in
 * `syncStatus.ts` because that file mirrors `status.py` and this list is a
 * detail of painting an icon: what it is for is taking the previous dot off
 * before putting the next one on.
 */
export const SYNC_DOT_NAMES: readonly SyncDot[] = ["ok", "working", "wait", "error"];

/** What a shared folder has to say about itself. */
export interface FolderStatus {
	/** Whether this device wants the folder connected at all. */
	shouldConnect: boolean;
	/**
	 * Whether the folder's own metadata document has caught up with the
	 * server. This is a fact about one document and says nothing about the
	 * notes listed in it.
	 */
	synced: boolean;
	/** Whether the walk that registers and seeds local files is still running. */
	filling: boolean;
	/** Notes this device has taken on for this folder, sends and fetches together. */
	total: number;
	/** How many of them came back with a body actually written. */
	completed: number;
}

/**
 * Whether this folder has nothing left to carry.
 *
 * `synced` on its own was the whole of the status, and it is the bug (#40).
 * It is one boolean about one document, it goes true the first time that
 * document catches up, and nothing ever puts it back. A vault of 2,567 notes
 * with not one body behind any of them satisfied it inside a minute, which is
 * how the corner of the window came to say up to date over an empty vault.
 *
 * The folder's own document is necessary and nowhere near sufficient, so two
 * more have to agree with it:
 *
 * - `filling` is the walk that finds every local file and copies the new ones
 *   into their documents. On a large vault it runs for minutes, and nothing is
 *   queued until it has found something, so a folder still walking has not yet
 *   said how much work there is to do.
 * - `completed` against `total` is every note the sync passes took on. A sync
 *   that came back without writing the body counts as failed rather than done
 *   (#38), so `completed` short of `total` means a note's body is not where it
 *   should be, whether it is still queued or came back empty.
 */
export function folderCaughtUp(folder: FolderStatus): boolean {
	return folder.synced && !folder.filling && folder.completed >= folder.total;
}

/**
 * Paused means every folder is off, not merely one of them: a person who
 * disconnected a single folder has not paused their vault. Syncing means a
 * folder that wants to be connected has not caught up yet, which covers both
 * the first pass and a reconnect after the laptop was shut.
 *
 * `held` is a vault with no folders at all that is not about to get one:
 * either something has to be dealt with before it can start (#41), or it is
 * waiting to be told which vault on Knap it belongs to (#42). A vault with
 * nothing shared normally reads as up to date, because signing in shares the
 * whole vault and the gap is a moment long. When the gap is not a moment,
 * saying up to date over a vault that is syncing nothing is the same lie #40
 * was about, so it reads Paused instead: nothing is moving, and the screen
 * underneath says why.
 */
export function vaultSyncWord(
	signedIn: boolean,
	folders: readonly FolderStatus[],
	held = false,
): SyncWord {
	return syncWord({
		signedIn,
		paused:
			(held && folders.length === 0) ||
			(folders.length > 0 && folders.every((folder) => !folder.shouldConnect)),
		syncing: folders.some(
			(folder) => folder.shouldConnect && !folderCaughtUp(folder),
		),
	});
}

/** Notes done and notes to do, over every folder this device is carrying. */
export interface VaultCounts {
	done: number;
	total: number;
}

/**
 * A folder this device has switched off contributes nothing: its notes are
 * not moving and counting them would put a number next to a vault that is
 * standing still.
 */
export function vaultCounts(folders: readonly FolderStatus[]): VaultCounts {
	let done = 0;
	let total = 0;
	for (const folder of folders) {
		if (!folder.shouldConnect) continue;
		done += folder.completed;
		total += folder.total;
	}
	return { done, total };
}

/** Everything either screen needs to draw the state of this vault. */
export interface VaultReading {
	word: SyncWord;
	dot: SyncDot;
	done: number;
	total: number;
	/** "290 of 2,567", or empty when there is nothing worth counting. */
	counts: string;
	/** How full the bar is, 0 to 1, or undefined when there is no bar. */
	progress: number | undefined;
}

/**
 * The whole reading, in one call, so the icon and the settings screen cannot
 * disagree about the same vault.
 *
 * The count and the bar only appear while notes are moving. Up to date has
 * nothing to count, and a number beside it would only invite the question of
 * what the other one is.
 */
export function vaultReading(
	signedIn: boolean,
	folders: readonly FolderStatus[],
	held = false,
): VaultReading {
	const word = vaultSyncWord(signedIn, folders, held);
	const { done, total } = vaultCounts(folders);
	const moving = word === SYNCING && total > 0;
	return {
		word,
		dot: syncDot(word),
		done,
		total,
		counts: moving ? syncCounts(done, total) : "",
		progress: moving ? syncProgress(done, total) : undefined,
	};
}
