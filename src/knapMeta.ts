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
