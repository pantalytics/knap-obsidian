"use strict";

/**
 * Whether a folder already has a share on a given server.
 *
 * Nothing in the client stops a second share being created on a folder that
 * already has one, and the create form used to give no sign that the first one
 * had worked, so pressing the button again was the obvious thing to do. These
 * are the checks that let a form refuse that second create before it is sent.
 */

export interface ShareLike {
	path: string;
}

/**
 * A share path reduced to the form two paths have to agree on to be the same
 * folder: no surrounding whitespace, no leading or trailing slash, no repeated
 * separators.
 */
export function normalizeSharePath(path: string): string {
	return path
		.trim()
		.replace(/\/+/g, "/")
		.replace(/^\/+|\/+$/g, "");
}

/**
 * The share already covering this path, if there is one.
 *
 * Paths are compared exactly once normalized. A vault on Linux keeps `Projects`
 * and `projects` apart, so folding case here would refuse a folder that really
 * is a different folder. An empty path matches nothing.
 */
export function findShareForPath<T extends ShareLike>(
	shares: readonly T[],
	path: string,
): T | undefined {
	const wanted = normalizeSharePath(path);
	if (!wanted) {
		return undefined;
	}
	return shares.find((share) => normalizeSharePath(share.path) === wanted);
}
