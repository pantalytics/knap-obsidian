"use strict";

/**
 * How a share maps vault paths to virtual paths, and what it refuses to touch.
 *
 * A share is either one folder inside the vault, which is what upstream
 * supports, or the whole vault. The difference is one prefix: a folder share
 * prefixes every virtual path with "Folder/", a vault share prefixes it with
 * nothing. Keeping that in one place is the point of this file -- the
 * arithmetic used to live inline as `this.path.length + 1`, which is off by
 * one for a vault share and was repeated at about thirty call sites.
 *
 * Pure functions, no Obsidian imports, so they can be unit tested directly.
 * `sharedFolderNesting.ts` is the pattern.
 */

export type ShareScope = "vault" | "folder";

/**
 * The prefix every vault path carries for this share.
 *
 * Folder scope gets a trailing separator so `startsWith` cannot match a
 * sibling whose name merely begins the same way ("Archive" must not match
 * "ArchiveOld"). Vault scope gets the empty string, which is what makes the
 * slice arithmetic below uniform across both.
 */
export function sharePrefix(
	scope: ShareScope,
	path: string,
	sep = "/",
): string {
	return scope === "vault" ? "" : path + sep;
}

/**
 * Segments a share never syncs, in either scope.
 *
 * This exists because a vault-scoped share has no folder prefix doing the job
 * implicitly. Upstream has no exclusion list at all: outbound it relies on
 * Obsidian's file index, which does not surface the config directory, and
 * inbound it relies on the share prefix. A vault share removes the second
 * guard, and the write path uses `vault.adapter` rather than the index, so a
 * remote entry naming `.obsidian/plugins/x/main.js` would otherwise be
 * written straight to disk.
 *
 * The rule is deliberately blunt: any segment starting with a dot, plus any
 * traversal. Obsidian's own config directory is configurable, so callers pass
 * it in rather than this file assuming ".obsidian".
 */
export function isExcludedPath(vaultPath: string, configDir?: string): boolean {
	if (!vaultPath) return true;

	const normalized = vaultPath.replace(/\\/g, "/");
	if (configDir) {
		const dir = configDir.replace(/^\/+|\/+$/g, "");
		if (dir && (normalized === dir || normalized.startsWith(dir + "/"))) {
			return true;
		}
	}

	for (const segment of normalized.split("/")) {
		if (segment === "" ) continue;
		if (segment === "." || segment === "..") return true;
		if (segment.startsWith(".")) return true;
	}
	return false;
}

/**
 * Is this vault path inside the share?
 *
 * Note what this deliberately keeps from upstream: a folder share does not
 * contain its own root. `checkPath("Folder")` is false for a share at
 * "Folder", because the share is the things inside it. A vault share
 * likewise does not contain the vault root itself.
 */
export function checkPath(
	scope: ShareScope,
	path: string,
	candidate: string,
	sep = "/",
	configDir?: string,
): boolean {
	if (!candidate || candidate === "/" || candidate === path) return false;
	if (isExcludedPath(candidate, configDir)) return false;
	if (scope === "vault") return true;
	return candidate.startsWith(sharePrefix(scope, path, sep));
}

/** The share-relative path. Caller must have checked `checkPath` first. */
export function toVirtualPath(
	scope: ShareScope,
	path: string,
	candidate: string,
	sep = "/",
): string {
	return candidate.slice(sharePrefix(scope, path, sep).length);
}

/**
 * A path and everything under it, out of the paths a share knows about.
 *
 * What deleting a folder means. A folder is an entry in the sync store like
 * any other, so removing only its own entry left the notes inside it in the
 * store, which is to say on every other device, and the folder came back the
 * next time one of them wrote. `renameFile` already walks children this way
 * for a `SyncFolder`; deleting has to walk the same set.
 *
 * The separator is appended before matching, so a sibling whose name merely
 * begins the same way is not swept up with it: deleting "Archive" must not
 * take "ArchiveOld/notes.md". The path itself comes first, and it is included
 * whether or not it is in `paths`, so a folder whose own entry has already
 * gone still clears out what is under it.
 */
export function descendantsOf(
	vpath: string,
	paths: Iterable<string>,
	sep = "/",
): string[] {
	const prefix = vpath + sep;
	const found = [vpath];
	for (const path of paths) {
		if (path.startsWith(prefix)) found.push(path);
	}
	return found;
}

/** The vault path for a share-relative path. The inverse of `toVirtualPath`. */
export function toVaultPath(
	scope: ShareScope,
	path: string,
	vpath: string,
	sep = "/",
): string {
	return sharePrefix(scope, path, sep) + vpath;
}
