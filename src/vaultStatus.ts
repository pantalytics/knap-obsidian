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
	/** Notes the cloud vault lists for this folder. */
	listed: number;
	/** How many of those have no file on this device yet. */
	missing: number;
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
 * - `missing` is the notes the cloud vault lists that have no file here. The
 *   three above are all about work this device took on, and a device that has
 *   just joined an existing cloud vault has taken none on: nothing local to
 *   walk, a metadata document that catches up in seconds, an empty queue. All
 *   three agreed, and the corner of the window said Up to date over a vault
 *   with 2,567 notes still to come. This one is a fact about the two file
 *   lists rather than about a queue, so it is true from the first second.
 */
export function folderCaughtUp(folder: FolderStatus): boolean {
	return (
		folder.synced &&
		!folder.filling &&
		folder.completed >= folder.total &&
		folder.missing <= 0
	);
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
 *
 * Two ways of counting one vault, and the queue is the first of them because
 * it is the one that knows what this device is doing. When there is nothing
 * in it and notes are still to come, the file lists answer instead: that is a
 * device downloading a vault it has just joined, where the queue is empty for
 * the same reason the vault is.
 *
 * They are never added together. A note being fetched is in the queue and
 * absent from the disk at the same time, so a sum counts it twice, and on the
 * device that uploaded the vault every note is listed and present, which
 * would push a first upload's bar to nearly full while it was barely started.
 */
export function vaultCounts(folders: readonly FolderStatus[]): VaultCounts {
	let done = 0;
	let total = 0;
	let present = 0;
	let listed = 0;
	for (const folder of folders) {
		if (!folder.shouldConnect) continue;
		done += folder.completed;
		total += folder.total;
		listed += folder.listed;
		present += Math.max(0, folder.listed - folder.missing);
	}
	if (total > 0) return { done, total };
	if (listed > 0 && present < listed) return { done: present, total: listed };
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

/** What the corner of the window puts on screen, worked out once. */
export interface StatusBarPaint {
	dot: SyncDot;
	/** "290 of 2,567", or empty while there is nothing worth counting. */
	count: string;
	/** The tooltip, which is where the word itself is said. */
	label: string;
	/**
	 * How wide the bar is drawn, 0 to 100, or undefined when there is no bar.
	 * A whole number because it goes straight into a width in percent, and a
	 * bar is two pixels tall: nothing below a percent is visible.
	 */
	percent: number | undefined;
}

/**
 * The corner of the window, in one call.
 *
 * The icon carries the word and the tooltip says it, so the count and the bar
 * are the only things that need working out, and both come off the reading
 * every other screen uses. It is here rather than in `main.ts` because a
 * phrasing that lives next to the elements it writes into is a phrasing no
 * test reaches.
 */
export function statusBarPaint(reading: VaultReading): StatusBarPaint {
	const word = reading.word.toLowerCase();
	return {
		dot: reading.dot,
		count: reading.counts,
		label: reading.counts ? `Knap: ${word}, ${reading.counts}` : `Knap: ${word}`,
		percent:
			reading.progress === undefined ? undefined : Math.round(reading.progress * 100),
	};
}
