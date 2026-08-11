"use strict";
import { requestUrl } from "obsidian";
import { Platform } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { curryLog } from "./debug";
import { flags } from "./flagManager";

declare const GIT_TAG: string;

if (window.Response === undefined || window.Headers === undefined) {
	// Fetch API is broken for some versions of Electron
	// https://github.com/electron/electron/pull/42419
	try {
		console.warn(
			"[Relay] Polyfilling Fetch API (Electron Bug: https://github.com/electron/electron/pull/42419)",
		);
		const windowRecord = window as unknown as Record<string, unknown>;
		if (windowRecord["blinkfetch"]) {
			window.fetch = windowRecord["blinkfetch"] as typeof window.fetch;
			const keys = ["fetch", "Response", "FormData", "Request", "Headers"];
			for (const key of keys) {
				windowRecord[key] = windowRecord[`blink${key}`];
			}
		}
	} catch (e: unknown) {
		console.error(e);
	}
}

if ((window as unknown as Record<string, unknown>)["EventSource"] === undefined) {
	if (Platform.isMobile) {
		console.warn(
			"[Relay] Polyfilling EventSource API required, but unable to polyfill on Mobile",
		);
	} else {
		console.warn("[Relay] Polyfilling EventSource API");
		// eventsource v4 exports { ErrorEvent, EventSource }, so the module object
		// is not itself a constructor. Assigning it whole left window.EventSource
		// as a plain object and `new EventSource(...)` would have thrown.
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy, desktop only
		const eventsource = require("eventsource") as typeof import("eventsource");
		(window as unknown as Record<string, unknown>)["EventSource"] = eventsource.EventSource;
	}
}

export const customFetch = async (
	url: RequestInfo | URL,
	config?: RequestInit,
): Promise<Response> => {
	// Convert URL object to string if necessary
	const urlString = url instanceof URL ? url.toString() : (url as string);

	const method = config?.method || "GET";

	const headers = Object.assign({}, config?.headers, {
		"Relay-Version": GIT_TAG,
	}) as Record<string, string>;

	// Prepare the request parameters
	const requestParams: RequestUrlParam = {
		url: urlString,
		method: method,
		body: config?.body as string | ArrayBuffer,
		headers: headers,
		throw: false,
	};

	// Retry logic for transient network errors (stale keep-alive connections, HTTP/2 RST_STREAM).
	// Only retry idempotent methods: a mutating request (POST/PUT/PATCH/DELETE) may have already
	// been applied server-side before the connection reset (e.g. RST after the record was
	// written), so retrying it risks creating a duplicate (TR-29).
	const isIdempotentMethod = method === "GET" || method === "HEAD";
	const maxRetries = isIdempotentMethod ? 2 : 0;
	let response: RequestUrlResponse | undefined = undefined;
	let lastError: unknown = undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			response = await requestUrl(requestParams);
			lastError = undefined;
			break;
		} catch (error: unknown) {
			lastError = error;
			const msg = error instanceof Error ? error.message : "";
			const isRetryable =
				msg.includes("net::ERR_FAILED") ||
				msg.includes("net::ERR_HTTP2") ||
				msg.includes("net::ERR_CONNECTION_RESET") ||
				msg.includes("GOAWAY") ||
				msg.includes("RST_STREAM");

			if (isRetryable && attempt < maxRetries) {
				curryLog("[CustomFetch]", "warn")(
					`Retrying ${method} ${urlString} (attempt ${attempt + 2}/${maxRetries + 1}): ${msg}`
				);
				continue;
			}

			if (isRetryable) {
				return new Response(JSON.stringify({ error: "Network request failed" }), {
					status: 503,
					statusText: "Service Unavailable",
					headers: new Headers({ "content-type": "application/json" }),
				});
			}
			throw error;
		}
	}

	if (!response) {
		throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
	}

	if (!response.arrayBuffer.byteLength) {
		return new Response(null, {
			status: response.status,
			statusText: response.status.toString(),
			headers: new Headers(response.headers),
		});
	}
	const fetchResponse = new Response(response.arrayBuffer, {
		status: response.status,
		statusText: response.status.toString(),
		headers: new Headers(response.headers),
	});

	// Add json method to the response
	const json = () => {
		return Promise.resolve(JSON.parse(response.text));
	};
	Object.defineProperty(fetchResponse, "json", {
		value: json,
	});

	if (flags().enableNetworkLogging) {
		const level =
			response.status >= 500
				? "error"
				: response.status >= 400
					? "warn"
					: "debug";
		const response_text = response.text;

		let response_json: unknown;
		const contentType = response.headers["content-type"] || "";
		if (contentType.includes("application/json")) {
			try {
				response_json = JSON.parse(response_text) as unknown;
			} catch {
				// pass
			}
		}

		curryLog("[CustomFetch]", level)(
			response.status.toString(),
			method,
			urlString,
			response_json || response_text,
		);
	}

	if (response.status >= 500) {
		throw new Error(response.text);
	}

	return fetchResponse;
};
