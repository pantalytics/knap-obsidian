/**
 * Tests for RelayOnPremTokenProvider.updateControlPlaneUrl() (TR-32).
 *
 * The provider is created once at plugin load and held for the plugin's
 * lifetime by LiveTokenStore — its `normalizedUrl` was baked in at
 * construction and never re-read, so editing the default server's URL in
 * settings left /tokens/relay requests going to the old host until Obsidian
 * restarted. updateControlPlaneUrl() is the fix's repoint mechanism;
 * main.ts wires it into the settings-change subscription (not covered here —
 * main.ts transitively imports LoginManager, which pulls in the ESM-only
 * `pocketbase` package and cannot be imported under this repo's Jest config).
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import {
	RelayOnPremTokenProvider,
	type RelayTokenResponse,
	type RelayTokenBatchResponse,
	type FileTokenApiResponse,
} from "../../src/auth/RelayOnPremTokenProvider";
import type { IAuthProvider } from "../../src/auth/IAuthProvider";

jest.mock("../../src/debug", () => ({
	curryLog: () => jest.fn(),
	HasLogging: class HasLogging {
		protected debug = jest.fn();
		protected log = jest.fn();
		protected warn = jest.fn();
		protected error = jest.fn();
	},
}));

jest.mock("../../src/customFetch");
import { customFetch } from "../../src/customFetch";
const mockFetch = customFetch as jest.MockedFunction<typeof customFetch>;

function mockFetchResponse(data: RelayTokenResponse) {
	return Promise.resolve({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(data),
		json: async () => data,
		headers: new Headers(),
	} as Response);
}

function makeAuthProvider(): IAuthProvider {
	return {
		isLoggedIn: () => true,
		getCurrentUser: () => undefined,
		getToken: () => "fake-token",
		getValidToken: async () => "fake-token",
		loginWithPassword: () => Promise.reject(new Error("unused")),
		loginWithOAuth2: () => Promise.reject(new Error("unused")),
		refreshToken: () => Promise.reject(new Error("unused")),
		logout: () => Promise.reject(new Error("unused")),
		isTokenValid: () => true,
	};
}

const TOKEN_RESPONSE: RelayTokenResponse = {
	relay_url: "wss://relay.example.com",
	token: "relay-token",
	expires_at: new Date(Date.now() + 60_000).toISOString(),
};

/**
 * The batch route's answer for whatever was asked for. Since tokens are
 * requested a slice at a time rather than a document at a time, this is the
 * shape almost every path in this file now gets back; the single-document
 * response above is what a control plane without the batch route answers.
 */
function batchFor(body: unknown): RelayTokenBatchResponse {
	const asked = (body as { doc_ids?: string[] }).doc_ids ?? [];
	return {
		relay_url: TOKEN_RESPONSE.relay_url,
		// Per token, exactly as the control plane answers it. There is no
		// batch-level expires_at, and assuming one is how every token ends up
		// with a NaN expiry.
		tokens: asked.map((doc_id) => ({
			doc_id,
			token: TOKEN_RESPONSE.token,
			expires_at: TOKEN_RESPONSE.expires_at,
		})),
	};
}

function mockBatchResponse(init: unknown) {
	const data = batchFor(JSON.parse((init as RequestInit).body as string));
	return Promise.resolve({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(data),
		json: async () => data,
		headers: new Headers(),
	} as Response);
}

describe("RelayOnPremTokenProvider.updateControlPlaneUrl", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("subsequent requestToken calls hit the new URL, not the one from construction", async () => {
		mockFetch.mockImplementation((_url, init) => mockBatchResponse(init));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://old-server.example.com",
			authProvider: makeAuthProvider(),
		});

		const first = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		await first;
		expect(mockFetch).toHaveBeenCalledWith(
			"https://old-server.example.com/v1/tokens/relay/batch",
			expect.anything(),
		);

		provider.updateControlPlaneUrl("https://new-server.example.com");

		// Second call queues behind the throttle's per-instance min-interval spacing.
		const second = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(2_400);
		await second;
		expect(mockFetch).toHaveBeenLastCalledWith(
			"https://new-server.example.com/v1/tokens/relay/batch",
			expect.anything(),
		);
	});

	test("normalizes a trailing slash on the new URL, same as the constructor does", async () => {
		mockFetch.mockImplementation((_url, init) => mockBatchResponse(init));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://old-server.example.com",
			authProvider: makeAuthProvider(),
		});

		provider.updateControlPlaneUrl("https://new-server.example.com/");

		const request = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		await request;
		expect(mockFetch).toHaveBeenLastCalledWith(
			"https://new-server.example.com/v1/tokens/relay/batch",
			expect.anything(),
		);
	});
});

/**
 * Tests for the write->read fallback (U3, Mesh #eb6ab38f).
 *
 * The caller (LiveTokenStoreRefresh.ts) always requests mode "write" regardless
 * of the member's actual share role. The control-plane correctly 403s a
 * viewer's write request (app/services/share_service.py::ensure_write_access,
 * verified live against tr-relay-vm + its own test_viewer_cannot_write test) --
 * without this fallback that 403 propagated as a hard connection failure,
 * leaving viewer-role members unable to open onprem relay shares at all.
 */
describe("RelayOnPremTokenProvider.requestToken write->read fallback", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockFetch.mockClear();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	function mockResponse(status: number, data: RelayTokenResponse | null) {
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			text: async () => (data ? JSON.stringify(data) : "Write access denied"),
			json: async () => data,
			headers: new Headers(),
		} as Response);
	}

	test("a 403 on a write request is retried once as read, and succeeds", async () => {
		let calls = 0;
		mockFetch.mockImplementation((_url, init) => {
			calls++;
			const body = JSON.parse((init as RequestInit).body as string);
			if (body.mode === "write") {
				return mockResponse(403, null);
			}
			expect(body.mode).toBe("read");
			return mockBatchResponse(init);
		});

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestToken("relay1", "folder1", "doc1", "write");
		await jest.advanceTimersByTimeAsync(2_400); // the retry queues behind the throttle
		const clientToken = await request;

		expect(calls).toBe(2);
		expect(clientToken.authorization).toBe("read-only");
		expect(clientToken.token).toBe(TOKEN_RESPONSE.token);
	});

	test("a 403 on an explicit read request does NOT retry (no infinite loop)", async () => {
		mockFetch.mockImplementation(() => mockResponse(403, null));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestToken("relay1", "folder1", "doc1", "read");
		const assertion = expect(request).rejects.toThrow(/403/);
		await jest.advanceTimersByTimeAsync(0);
		await assertion;
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	test("an editor's write request still succeeds on the first try, no fallback triggered", async () => {
		mockFetch.mockImplementation((_url, init) => mockBatchResponse(init));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestToken("relay1", "folder1", "doc1", "write");
		await jest.advanceTimersByTimeAsync(0);
		const clientToken = await request;

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(clientToken.authorization).toBe("full");
	});
});

/**
 * Tests for requestFileToken (TR-09) — the attachment (CAS) presigned-URL
 * token flow, wired into LiveTokenStore.fetchFileToken's relay-onprem
 * branch. Hits POST /shares/{id}/file-token, distinct from requestToken's
 * /tokens/relay (WebSocket doc connection). CAS.ts (untouched by this task)
 * reads only `token.baseUrl` and `token.token` off the result and does
 * HEAD/GET/POST against baseUrl (+ "/download-url" | "/upload-url") — so the
 * returned FileToken MUST have baseUrl populated, not just `url`.
 */
describe("RelayOnPremTokenProvider.requestFileToken", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockFetch.mockClear();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	const FILE_TOKEN_RESPONSE: FileTokenApiResponse = {
		token: "file-scoped-token",
		base_url: "https://cp.example.com/shares/folder1/files/file1",
		expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
	};

	function mockFileTokenResponse(status: number, data: FileTokenApiResponse | null) {
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			text: async () => (data ? JSON.stringify(data) : "error body"),
			json: async () => data,
			headers: new Headers(),
		} as Response);
	}

	test("POSTs to /v1/shares/{folderId}/file-token with fileId as the path, sha256/content_type/content_length in the body", async () => {
		mockFetch.mockImplementation(() => mockFileTokenResponse(200, FILE_TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestFileToken(
			"relay1",
			"folder1",
			"file1",
			"deadbeef",
			"image/png",
			12345,
		);
		await jest.advanceTimersByTimeAsync(0);
		await request;

		expect(mockFetch).toHaveBeenCalledWith(
			"https://cp.example.com/v1/shares/folder1/file-token",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer fake-token",
					"Content-Type": "application/json",
				}),
				body: JSON.stringify({
					path: "file1",
					sha256: "deadbeef",
					content_type: "image/png",
					content_length: 12345,
				}),
			}),
		);
	});

	test("maps base_url into token.baseUrl (and mirrors it into token.url) — CAS.ts does a non-null assertion on baseUrl", async () => {
		mockFetch.mockImplementation(() => mockFileTokenResponse(200, FILE_TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestFileToken(
			"relay1",
			"folder1",
			"file1",
			"deadbeef",
			"image/png",
			12345,
		);
		await jest.advanceTimersByTimeAsync(0);
		const fileToken = await request;

		expect(fileToken.baseUrl).toBe(FILE_TOKEN_RESPONSE.base_url);
		expect(fileToken.url).toBe(FILE_TOKEN_RESPONSE.base_url);
		expect(fileToken.token).toBe("file-scoped-token");
		expect(fileToken.docId).toBe("file1");
		expect(fileToken.folder).toBe("folder1");
		expect(fileToken.contentType).toBe("image/png");
		expect(fileToken.contentLength).toBe(12345);
		expect(fileToken.fileHash).toBe("deadbeef");
	});

	test("throws when not authenticated, without hitting the network", async () => {
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: {
				...makeAuthProvider(),
				getValidToken: async () => undefined,
			},
		});

		await expect(
			provider.requestFileToken("relay1", "folder1", "file1", "deadbeef", "image/png", 12345),
		).rejects.toThrow("Not authenticated");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	test("429 throws RateLimitError with the parsed Retry-After delay", async () => {
		mockFetch.mockImplementation(() =>
			Promise.resolve({
				ok: false,
				status: 429,
				text: async () => "slow down",
				json: async () => null,
				headers: new Headers({ "Retry-After": "12" }),
			} as Response),
		);

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestFileToken(
			"relay1",
			"folder1",
			"file1",
			"deadbeef",
			"image/png",
			12345,
		);
		const assertion = expect(request).rejects.toMatchObject({
			name: "RateLimitError",
			retryAfterMs: 12_000,
		});
		await jest.advanceTimersByTimeAsync(0);
		await assertion;
	});

	test("a non-ok, non-429 response throws with the status and body text", async () => {
		mockFetch.mockImplementation(() => mockFileTokenResponse(403, null));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://cp.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestFileToken(
			"relay1",
			"folder1",
			"file1",
			"deadbeef",
			"image/png",
			12345,
		);
		const assertion = expect(request).rejects.toThrow(/403/);
		await jest.advanceTimersByTimeAsync(0);
		await assertion;
	});
});

/**
 * Tests for batched token requests (ADR-0051 in knap-mcp-admin).
 *
 * The control plane allows 30 token requests a minute and a token is scoped to
 * one document, so this provider throttles itself to 25 and a vault of a few
 * thousand notes could not start syncing in under an hour. The batch route
 * mints many at once; what these tests hold to is that everything waiting on a
 * slot travels together, that each document still gets its own token, and that
 * a control plane without the route still works.
 */
describe("RelayOnPremTokenProvider batched token requests", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockFetch.mockClear();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	function bodiesOf(): Array<{ doc_ids?: string[]; doc_id?: string }> {
		return mockFetch.mock.calls.map((call) =>
			JSON.parse((call[1] as RequestInit).body as string),
		);
	}

	test("documents asked for together cost one request", async () => {
		mockFetch.mockImplementation((_url, init) => mockBatchResponse(init));
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const requests = ["doc1", "doc2", "doc3"].map((doc) =>
			provider.requestToken("relay1", "folder1", doc, "write"),
		);
		await jest.advanceTimersByTimeAsync(0);
		const tokens = await Promise.all(requests);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(bodiesOf()[0].doc_ids).toEqual(["doc1", "doc2", "doc3"]);
		expect(tokens.map((t) => t.docId)).toEqual(["doc1", "doc2", "doc3"]);
	});

	test("what arrives while a slot is being waited for travels with it", async () => {
		// The whole mechanism in one test. The first request takes the slot
		// immediately; the second and third arrive during the 2.4s wait for
		// the next one and go out together rather than one every 2.4s.
		mockFetch.mockImplementation((_url, init) => mockBatchResponse(init));
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const first = provider.requestToken("relay1", "folder1", "doc1", "write");
		await jest.advanceTimersByTimeAsync(0);
		await first;

		const later = [
			provider.requestToken("relay1", "folder1", "doc2", "write"),
			provider.requestToken("relay1", "folder1", "doc3", "write"),
		];
		await jest.advanceTimersByTimeAsync(2_400);
		await Promise.all(later);

		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(bodiesOf()[1].doc_ids).toEqual(["doc2", "doc3"]);
	});

	test("each document gets its own token, never a shared one", async () => {
		mockFetch.mockImplementation((_url, init) => {
			const asked = JSON.parse((init as RequestInit).body as string)
				.doc_ids as string[];
			const data: RelayTokenBatchResponse = {
				relay_url: "wss://relay.example.com",
				tokens: asked.map((doc_id) => ({
					doc_id,
					token: `token-${doc_id}`,
					expires_at: new Date(Date.now() + 60_000).toISOString(),
				})),
			};
			return Promise.resolve({
				ok: true,
				status: 200,
				text: async () => JSON.stringify(data),
				json: async () => data,
				headers: new Headers(),
			} as Response);
		});
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const requests = ["doc1", "doc2"].map((doc) =>
			provider.requestToken("relay1", "folder1", doc, "write"),
		);
		await jest.advanceTimersByTimeAsync(0);
		const [one, two] = await Promise.all(requests);

		expect(one.token).toBe("token-doc1");
		expect(two.token).toBe("token-doc2");
	});

	test("two shares are two requests: a token is scoped to one of them", async () => {
		mockFetch.mockImplementation((_url, init) => mockBatchResponse(init));
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const requests = [
			provider.requestToken("relay1", "folderA", "doc1", "write"),
			provider.requestToken("relay1", "folderB", "doc2", "write"),
		];
		await jest.advanceTimersByTimeAsync(2_400);
		await Promise.all(requests);

		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	test("the same document asked for twice is one token and two answers", async () => {
		mockFetch.mockImplementation((_url, init) => mockBatchResponse(init));
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const requests = [
			provider.requestToken("relay1", "folder1", "doc1", "write"),
			provider.requestToken("relay1", "folder1", "doc1", "write"),
		];
		await jest.advanceTimersByTimeAsync(0);
		const [one, two] = await Promise.all(requests);

		expect(bodiesOf()[0].doc_ids).toEqual(["doc1"]);
		expect(one.token).toBe(two.token);
	});

	test("a control plane without the batch route still hands out tokens", async () => {
		// The plugin and the server it talks to are versioned separately, so a
		// build can meet a control plane that has never heard of this route.
		// Slower beats not starting.
		mockFetch.mockImplementation((url, init) => {
			if (String(url).endsWith("/v1/tokens/relay/batch")) {
				return Promise.resolve({
					ok: false,
					status: 404,
					text: async () => "Not Found",
					json: async () => ({}),
					headers: new Headers(),
				} as Response);
			}
			return mockFetchResponse(TOKEN_RESPONSE);
		});
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const requests = ["doc1", "doc2"].map((doc) =>
			provider.requestToken("relay1", "folder1", doc, "write"),
		);
		await jest.advanceTimersByTimeAsync(5_000);
		const tokens = await Promise.all(requests);

		expect(tokens.map((t) => t.token)).toEqual(["relay-token", "relay-token"]);
		const batchCalls = mockFetch.mock.calls.filter((call) =>
			String(call[0]).endsWith("/batch"),
		);
		expect(batchCalls).toHaveLength(1);
	});

	test("after the route is known missing, nothing asks for it again", async () => {
		mockFetch.mockImplementation((url) => {
			if (String(url).endsWith("/v1/tokens/relay/batch")) {
				return Promise.resolve({
					ok: false,
					status: 404,
					text: async () => "Not Found",
					json: async () => ({}),
					headers: new Headers(),
				} as Response);
			}
			return mockFetchResponse(TOKEN_RESPONSE);
		});
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		// The first one spends a slot on the batch attempt and another on the
		// single request it falls back to, so it needs both intervals.
		const first = provider.requestToken("relay1", "folder1", "doc1", "write");
		await jest.advanceTimersByTimeAsync(5_000);
		await first;
		mockFetch.mockClear();

		const later = provider.requestToken("relay1", "folder1", "doc2", "write");
		await jest.advanceTimersByTimeAsync(2_400);
		await later;

		expect(
			mockFetch.mock.calls.filter((call) => String(call[0]).endsWith("/batch")),
		).toHaveLength(0);
	});

	test("each token's expiry comes from its own entry, not from the batch", async () => {
		// The control plane answers expires_at per token and carries none for
		// the batch. Reading a batch-level one yields undefined, and
		// `new Date(undefined).getTime()` is NaN -- which TokenStore reads as
		// expired forever, so nothing would ever cache and every document
		// would pay for a token it had already been given.
		const expiry = new Date(Date.now() + 5 * 60_000).toISOString();
		mockFetch.mockImplementation((_url, init) => {
			const asked = JSON.parse((init as RequestInit).body as string)
				.doc_ids as string[];
			const data: RelayTokenBatchResponse = {
				relay_url: "wss://relay.example.com",
				tokens: asked.map((doc_id) => ({
					doc_id,
					token: `token-${doc_id}`,
					expires_at: expiry,
				})),
			};
			return Promise.resolve({
				ok: true,
				status: 200,
				text: async () => JSON.stringify(data),
				json: async () => data,
				headers: new Headers(),
			} as Response);
		});
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const request = provider.requestToken("relay1", "folder1", "doc1", "write");
		await jest.advanceTimersByTimeAsync(0);
		const clientToken = await request;

		expect(clientToken.expiryTime).toBe(new Date(expiry).getTime());
		expect(Number.isNaN(clientToken.expiryTime)).toBe(false);
	});

	test("a batch that skips a document refuses for it rather than guessing", async () => {
		mockFetch.mockImplementation((_url, init) => {
			const asked = JSON.parse((init as RequestInit).body as string)
				.doc_ids as string[];
			const data: RelayTokenBatchResponse = {
				relay_url: "wss://relay.example.com",
				// Answers for the first and quietly drops the second.
				tokens: asked.slice(0, 1).map((doc_id) => ({
					doc_id,
					token: "t",
					expires_at: new Date(Date.now() + 60_000).toISOString(),
				})),
			};
			return Promise.resolve({
				ok: true,
				status: 200,
				text: async () => JSON.stringify(data),
				json: async () => data,
				headers: new Headers(),
			} as Response);
		});
		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://relay.example.com",
			authProvider: makeAuthProvider(),
		});

		const good = provider.requestToken("relay1", "folder1", "doc1", "write");
		const bad = provider.requestToken("relay1", "folder1", "doc2", "write");
		const assertion = expect(bad).rejects.toThrow(/No relay token issued/);
		await jest.advanceTimersByTimeAsync(0);
		await assertion;
		await expect(good).resolves.toMatchObject({ docId: "doc1" });
	});
});
