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

describe("RelayOnPremTokenProvider.updateControlPlaneUrl", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("subsequent requestToken calls hit the new URL, not the one from construction", async () => {
		mockFetch.mockImplementation(() => mockFetchResponse(TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://old-server.example.com",
			authProvider: makeAuthProvider(),
		});

		const first = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		await first;
		expect(mockFetch).toHaveBeenCalledWith(
			"https://old-server.example.com/tokens/relay",
			expect.anything(),
		);

		provider.updateControlPlaneUrl("https://new-server.example.com");

		// Second call queues behind the throttle's per-instance min-interval spacing.
		const second = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(2_400);
		await second;
		expect(mockFetch).toHaveBeenLastCalledWith(
			"https://new-server.example.com/tokens/relay",
			expect.anything(),
		);
	});

	test("normalizes a trailing slash on the new URL, same as the constructor does", async () => {
		mockFetch.mockImplementation(() => mockFetchResponse(TOKEN_RESPONSE));

		const provider = new RelayOnPremTokenProvider({
			controlPlaneUrl: "https://old-server.example.com",
			authProvider: makeAuthProvider(),
		});

		provider.updateControlPlaneUrl("https://new-server.example.com/");

		const request = provider.requestToken("relay1", "folder1", "doc1");
		await jest.advanceTimersByTimeAsync(0);
		await request;
		expect(mockFetch).toHaveBeenLastCalledWith(
			"https://new-server.example.com/tokens/relay",
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
			return mockResponse(200, TOKEN_RESPONSE);
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
		mockFetch.mockImplementation(() => mockResponse(200, TOKEN_RESPONSE));

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
