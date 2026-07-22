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
