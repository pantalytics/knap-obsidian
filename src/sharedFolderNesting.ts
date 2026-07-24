"use strict";

/**
 * Pure nesting-conflict check for shared folders, extracted from
 * SharedFolders.findNestingConflict so it can be unit-tested directly --
 * SharedFolder.ts transitively imports Document.ts/LoginManager.ts
 * (pocketbase, ESM-only), which Jest cannot parse.
 *
 * Relay does not support nested shares: two SharedFolders covering
 * overlapping files (e.g. share "A", then share "A/B") race on which one
 * processes a given file, non-deterministically (TR-30).
 *
 * Returns the path of the existing share that conflicts with `newPath` by
 * nesting in either direction -- newPath is a subfolder of an existing
 * share, or newPath would itself contain one -- or null if sharing
 * `newPath` is safe.
 */
export function findNestingConflictPath(
	newPath: string,
	existingPaths: string[],
	sep: string,
): string | null {
	for (const existingPath of existingPaths) {
		if (newPath.startsWith(existingPath + sep)) {
			return existingPath;
		}
	}
	for (const existingPath of existingPaths) {
		if (existingPath.startsWith(newPath + sep)) {
			return existingPath;
		}
	}
	return null;
}
