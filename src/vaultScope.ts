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
 * Which of the two shapes a stored share record is.
 *
 * The field is the answer whenever it is there. When it is not, the path is:
 * a folder share is a folder inside the vault and always has a name, and the
 * only share rooted at the vault itself is the vault share. So an empty path
 * with no scope beside it is a vault share, and reading it as a folder share
 * is what took the vault down on a restart.
 *
 * Records with no `scope` are not only old ones. Up to 1.12.3 nothing ever
 * wrote the field, so every install has records that predate it, including
 * ones written a minute ago. The inference is what those need, and it is
 * cheap enough to keep afterwards.
 */
export function shareScopeOf(record: {
	path?: string;
	scope?: ShareScope;
}): ShareScope {
	if (record.scope === "vault" || record.scope === "folder") {
		return record.scope;
	}
	const path = (record.path ?? "").trim();
	return path === "" || path === "/" ? "vault" : "folder";
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

/** The vault path for a share-relative path. The inverse of `toVirtualPath`. */
export function toVaultPath(
	scope: ShareScope,
	path: string,
	vpath: string,
	sep = "/",
): string {
	return sharePrefix(scope, path, sep) + vpath;
}
