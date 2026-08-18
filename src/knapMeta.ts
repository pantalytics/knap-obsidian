"use strict";

import * as Y from "yjs";
import type { ShareScope } from "./vaultScope";

/**
 * The one key in a shared folder's document that is ours.
 *
 * Knap's web page draws a vault, not a machine, and it has nowhere else to
 * learn a vault's name from. The control plane keeps `id`, `kind`, `path`,
 * `visibility` and the web-publishing fields for a share and nothing more
 * (`RelayOnPremShareClient.ts`), and `path` is the vault's name on a
 * whole-vault share and a folder's name on a folder share, with nothing in the
 * record telling the two apart. Guessing from the shape of the paths inside
 * would be a guess, so the side that knows says so instead.
 *
 * The folder document is the channel because both sides already hold it open:
 * Knap's replica reparses it on every event, so reading this costs no request
 * and no token, and upstream neither reads nor writes the key.
 *
 * Versioned in its own name, the way `filemeta_v0` is, and namespaced because
 * it lives in a document upstream also writes.
 */
export const KNAP_META_KEY = "knap_v0";

/** What we put there. Both fields are plain strings and both are optional. */
export interface KnapMeta {
	/** Which of the two shapes this share is (`vaultScope.ts`). */
	scope: ShareScope;
	/** The vault's name in Obsidian, the word the person calls it by. */
	vault: string;
}

/**
 * Write the share's identity into its folder document, if it has changed.
 *
 * Idempotent on purpose, and called on every connect rather than once at
 * creation: a share made by an older build carries no key at all. Comparing
 * before writing is what keeps that from being an update every device
 * broadcasts on every start.
 *
 * **The name is written once and never overwritten.** A vault on Knap is now
 * picked from a list rather than matched by name, so one vault can be open in
 * local vaults called different things, on purpose and on the same account.
 * Whichever connected last would otherwise rename it for everybody, and the
 * name on Knap's page would follow whoever opened Obsidian most recently. The
 * first device to sync a vault gives it its name, which is the device that
 * made it, and it keeps that name until somebody has a screen to change it on.
 *
 * The scope is not a name and does get corrected: it says which of the two
 * shapes a share is, both sides compute it the same way, and a share whose
 * shape changed under an older build has a stale one worth fixing.
 */
export function stampKnapMeta(ydoc: Y.Doc, meta: KnapMeta): boolean {
	const map = ydoc.getMap<string>(KNAP_META_KEY);
	const named = map.get("vault");
	const vault = typeof named === "string" && named.trim() ? named : meta.vault.trim();
	if (map.get("scope") === meta.scope && map.get("vault") === vault) {
		return false;
	}
	ydoc.transact(() => {
		map.set("scope", meta.scope);
		map.set("vault", vault);
	});
	return true;
}

/** What the document says, for tests and for anything that wants to read back. */
export function readKnapMeta(ydoc: Y.Doc): KnapMeta | null {
	const map = ydoc.getMap<string>(KNAP_META_KEY);
	const scope = map.get("scope");
	const vault = map.get("vault");
	if (scope !== "vault" && scope !== "folder") {
		return null;
	}
	return { scope, vault: typeof vault === "string" ? vault : "" };
}

/**
 * Which local vaults sync this cloud vault, and on what.
 *
 * A cloud vault is one thing and the local vaults pointed at it are many:
 * since the picker (#55) they can be called different things, sit on different
 * machines, and run different builds of this plugin. Knap's page draws the
 * cloud vault and had no way to name any of them.
 *
 * **It goes in the same document and for the same reasons as the key above.**
 * The document is the cloud vault, so an entry in it is per cloud vault by
 * construction, with nothing to join and nothing to attribute. Both sides
 * already hold it open, so writing costs no request and no relay token, and
 * reading costs the replica a dict lookup on an event it was getting anyway.
 * Upstream neither reads nor writes it.
 *
 * A map of its own rather than more keys in `knap_v0`, because the two carry
 * different shapes: that one is two strings about the vault, this one is a
 * row per device. Versioned in its own name for the same reason as both.
 *
 * **One key per device, so nobody overwrites anybody.** The vault's name in
 * `knap_v0` is a single value and two devices disagreeing about it settle on
 * whichever wrote last; here each device owns its own key, keyed by the id
 * Obsidian gives this vault on this machine. Two devices are two rows and
 * always were two rows.
 */
export const KNAP_DEVICES_KEY = "knap_devices_v0";

/** One local vault, as the device syncing it describes itself. */
export interface KnapDevice {
	/** What Obsidian calls this vault on this device. */
	vault: string;
	/** Desktop or mobile, which is as specific as Obsidian will say. */
	platform: string;
	/** The plugin build writing this, so a stale device is recognisable. */
	version: string;
	/**
	 * Which account this device is signed in as, by the relay's id for them.
	 *
	 * The id and never the address. Everybody on the vault reads this
	 * document, and Knap's page already knows what address the id belongs to
	 * because it is the one on the vault's own member list, so writing the
	 * address here would put a second copy of somebody's email in a place
	 * nothing can correct it (ADR-0067 in the admin repository).
	 *
	 * Empty for a device that is not signed in, which is a state the row
	 * outlives: the vault stays on the list with nobody's name on it.
	 */
	user: string;
	/** When this device last connected, epoch milliseconds. */
	seen: number;
}

/**
 * How often a device rewrites its own row when nothing else about it changed.
 *
 * The row exists to answer "which devices sync this vault, and when was each
 * of them last here". A timestamp that only moves when somebody renames their
 * vault would answer the first half and lie about the second, and a timestamp
 * rewritten on every reconnect turns a flaky connection into a stream of
 * updates every other device receives. An hour is longer than a reconnect
 * storm and shorter than a working day, which is the resolution the screen
 * reading this actually shows.
 */
export const DEVICE_STAMP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Say that this local vault syncs this cloud vault, if that has changed.
 *
 * Returns whether anything was written, on the same terms as the stamp above:
 * called on every connect, quiet when there is nothing new to say.
 */
export function stampKnapDevice(
	ydoc: Y.Doc,
	installId: string,
	device: KnapDevice,
): boolean {
	const id = installId.trim();
	if (!id) return false;
	const devices = ydoc.getMap<string>(KNAP_DEVICES_KEY);
	const mine = readDevice(devices.get(id));
	if (
		mine &&
		mine.vault === device.vault &&
		mine.platform === device.platform &&
		mine.version === device.version &&
		mine.user === device.user &&
		device.seen - mine.seen < DEVICE_STAMP_INTERVAL_MS
	) {
		return false;
	}
	ydoc.transact(() => {
		devices.set(id, JSON.stringify(device));
	});
	return true;
}

/**
 * Take this local vault's row out, when it stops syncing this cloud vault.
 *
 * Leaving is the one moment a device knows it is gone. Everything else that
 * ends a row -- a laptop that was wiped, a vault deleted in Obsidian -- ends
 * it silently, which is why the reader ages rows out rather than trusting
 * this to have run.
 */
export function forgetKnapDevice(ydoc: Y.Doc, installId: string): boolean {
	const devices = ydoc.getMap<string>(KNAP_DEVICES_KEY);
	if (!devices.has(installId)) return false;
	ydoc.transact(() => {
		devices.delete(installId);
	});
	return true;
}

/** Every device that has said it syncs this cloud vault. */
export function readKnapDevices(ydoc: Y.Doc): Record<string, KnapDevice> {
	const devices = ydoc.getMap<string>(KNAP_DEVICES_KEY);
	const out: Record<string, KnapDevice> = {};
	for (const [id, raw] of devices.entries()) {
		const one = readDevice(raw);
		if (one) out[id] = one;
	}
	return out;
}

/**
 * One row, or nothing.
 *
 * Read defensively, the way `readKnapMeta` is and for the same reason: the
 * writer is a plugin that ships separately and updates on its own schedule, so
 * a row of the wrong shape is a version skew rather than a bug, and this runs
 * inside a sync callback that must not throw.
 */
function readDevice(raw: unknown): KnapDevice | null {
	if (typeof raw !== "string" || !raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<KnapDevice>;
		if (typeof parsed !== "object" || parsed === null) return null;
		return {
			vault: typeof parsed.vault === "string" ? parsed.vault : "",
			platform: typeof parsed.platform === "string" ? parsed.platform : "",
			version: typeof parsed.version === "string" ? parsed.version : "",
			user: typeof parsed.user === "string" ? parsed.user : "",
			seen: typeof parsed.seen === "number" ? parsed.seen : 0,
		};
	} catch {
		return null;
	}
}
