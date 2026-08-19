/**
 * Obsidian's requestUrl, wearing the fetch shape KnapServer expects.
 *
 * `requestUrl` rather than `fetch` because it skips CORS on both platforms,
 * which is what lets the server stay free of CORS headers for the plugin's
 * sake. `throw: false` so an HTTP error is an answer with a status, the way
 * fetch behaves and the way KnapServer reads it.
 */

import { requestUrl } from "obsidian";

import type { Fetch, HttpAnswer } from "./KnapServer";

export const obsidianFetch: Fetch = async (url, init): Promise<HttpAnswer> => {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(init?.headers ?? {})) {
		headers[key] = String(value);
	}
	const response = await requestUrl({
		url,
		method: init?.method ?? "GET",
		headers,
		body: init?.body as string | ArrayBuffer | undefined,
		throw: false,
	});
	return {
		ok: response.status >= 200 && response.status < 300,
		status: response.status,
		json: async () => response.json as unknown,
		arrayBuffer: async () => response.arrayBuffer,
	};
};
