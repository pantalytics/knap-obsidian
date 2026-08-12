/**
 * Tests for OAuthHandler
 *
 * Tests OAuth flow orchestration with mocked dependencies.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { OAuthHandler } from "../../src/auth/OAuthHandler";

// Mock dependencies
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

jest.mock("../../src/auth/OAuthDeepLinkReceiver", () => ({
	OAUTH_CALLBACK_ACTION: "synced-vaults/oauth-callback",
	OAUTH_RETURN_URL: "obsidian://synced-vaults/oauth-callback",
	oauthDeepLinkReceiver: {
		waitForCallback: jest.fn(),
		cancel: jest.fn(),
		handleCallback: jest.fn(),
		isWaiting: false,
	},
}));
import { oauthDeepLinkReceiver } from "../../src/auth/OAuthDeepLinkReceiver";
const mockReceiver = oauthDeepLinkReceiver as jest.Mocked<
	typeof oauthDeepLinkReceiver
>;

// Helper to create mock fetch response
function mockFetchResponse(status: number, data: any, ok = true) {
	return Promise.resolve({
		ok: ok !== false && status < 400,
		status,
		text: async () => JSON.stringify(data),
		json: async () => data,
		arrayBuffer: new ArrayBuffer(0),
		headers: new Headers(),
	} as Response);
}

describe("OAuthHandler", () => {
	const CONTROL_PLANE_URL = "https://cp.example.com";
	const SERVER_ID = "test-server-123";
	const PROVIDER = "zitadel";

	/** What the control plane hands back over the deep link once it has
	 *  exchanged the code itself. */
	const SESSION = {
		state: "state_xyz",
		accessToken: "access_token_abc",
		expiresIn: 3600,
		userId: "user-123",
		userEmail: "test@example.com",
		userName: "Test User",
	};

	let handler: OAuthHandler;

	beforeEach(() => {
		jest.clearAllMocks();

		handler = new OAuthHandler(CONTROL_PLANE_URL, SERVER_ID);
	});

	async function prepare(state = "state_xyz") {
		mockFetch.mockResolvedValueOnce(
			await mockFetchResponse(200, {
				authorize_url: "https://idp.example.com/oauth/v2/authorize",
				state,
			}),
		);
		return handler.prepareOAuthFlow(PROVIDER);
	}

	describe("prepareOAuthFlow()", () => {
		test("P7: Calls authorize endpoint correctly", async () => {
			const authorizeUrl = "https://idp.example.com/oauth/v2/authorize?...";
			mockFetch.mockResolvedValue(
				await mockFetchResponse(200, { authorize_url: authorizeUrl, state: "state_xyz" }),
			);

			const result = await handler.prepareOAuthFlow(PROVIDER);

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining(
					`${CONTROL_PLANE_URL}/v1/auth/oauth/${PROVIDER}/authorize`,
				),
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						Accept: "application/json",
					}),
				}),
			);
			expect(result).toEqual({
				authorizeUrl,
				returnUrl: "obsidian://synced-vaults/oauth-callback",
			});
		});

		test("The IdP is sent the control plane's callback, never the custom scheme", async () => {
			// Measured 2026-08-11: Zitadel stores a custom scheme on a Web app
			// and then refuses it at authorize time. So the custom scheme goes
			// in return_url, which the control plane keeps to itself, and
			// redirect_uri is an https URI the IdP already has registered.
			await prepare();

			const url = new URL(String(mockFetch.mock.calls[0][0]));
			expect(url.searchParams.get("redirect_uri")).toBe(
				`${CONTROL_PLANE_URL}/v1/auth/oauth/${PROVIDER}/callback`,
			);
			expect(url.searchParams.get("return_url")).toBe(
				"obsidian://synced-vaults/oauth-callback",
			);
		});

		test("P8: Error stops the pending flow", async () => {
			mockFetch.mockResolvedValue(
				await mockFetchResponse(500, { error: "Server error" }, false),
			);

			await expect(handler.prepareOAuthFlow(PROVIDER)).rejects.toThrow(
				"Failed to get authorize URL",
			);

			expect(mockReceiver.cancel).toHaveBeenCalled();
		});

		test("P9: Missing authorize_url throws error", async () => {
			mockFetch.mockResolvedValue(await mockFetchResponse(200, {}));

			await expect(handler.prepareOAuthFlow(PROVIDER)).rejects.toThrow(
				"No authorize URL returned from control plane",
			);

			expect(mockReceiver.cancel).toHaveBeenCalled();
		});

		test("P9b-TR21: Missing state throws error (nothing to verify the callback against)", async () => {
			mockFetch.mockResolvedValue(
				await mockFetchResponse(200, {
					authorize_url: "https://idp.example.com/oauth/v2/authorize",
				}),
			);

			await expect(handler.prepareOAuthFlow(PROVIDER)).rejects.toThrow(
				"No state token returned from control plane",
			);

			expect(mockReceiver.cancel).toHaveBeenCalled();
		});

		test("P14: URL normalization (trailing slashes)", async () => {
			const handlerWithSlash = new OAuthHandler(
				"https://cp.example.com/",
				SERVER_ID,
			);
			const handlerWithMultipleSlashes = new OAuthHandler(
				"https://cp.example.com///",
				SERVER_ID,
			);

			mockFetch.mockResolvedValue(
				await mockFetchResponse(200, {
					authorize_url: "https://idp.example.com/oauth/v2/authorize",
					state: "state_xyz",
				}),
			);

			await handlerWithSlash.prepareOAuthFlow(PROVIDER);
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("https://cp.example.com/v1/auth/oauth"),
				expect.anything(),
			);

			mockFetch.mockClear();

			await handlerWithMultipleSlashes.prepareOAuthFlow(PROVIDER);
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("https://cp.example.com/v1/auth/oauth"),
				expect.anything(),
			);
		});
	});

	describe("waitForCallbackAndExchange()", () => {
		test("P10: Turns the session into an AuthResponse", async () => {
			mockReceiver.waitForCallback.mockResolvedValue(SESSION);

			await prepare();
			mockFetch.mockClear();

			const result = await handler.waitForCallbackAndExchange(PROVIDER);

			expect(mockReceiver.waitForCallback).toHaveBeenCalledWith("state_xyz", 300000);
			// The control plane exchanged the code before it redirected, so
			// there is nothing left for this side to call.
			expect(mockFetch).not.toHaveBeenCalled();

			expect(result).toEqual({
				user: {
					id: "user-123",
					email: "test@example.com",
					name: "Test User",
					picture: undefined,
				},
				token: {
					token: "access_token_abc",
					expiresAt: expect.any(Number),
				},
				refreshToken: undefined,
			});
		});

		test("P11: Includes the refresh token if the callback carried one", async () => {
			mockReceiver.waitForCallback.mockResolvedValue({
				...SESSION,
				refreshToken: "refresh_token_xyz",
			});

			await prepare();

			const result = await handler.waitForCallbackAndExchange(PROVIDER);

			expect(result.refreshToken).toBe("refresh_token_xyz");
		});

		test("Falls back to the email when no display name comes back", async () => {
			mockReceiver.waitForCallback.mockResolvedValue({
				...SESSION,
				userName: undefined,
			});

			await prepare();

			const result = await handler.waitForCallbackAndExchange(PROVIDER);

			expect(result.user.name).toBe("test@example.com");
		});

		test("P12: Handles callback error", async () => {
			mockReceiver.waitForCallback.mockRejectedValue(
				new Error("OAuth callback timeout"),
			);

			await prepare();

			await expect(
				handler.waitForCallbackAndExchange(PROVIDER),
			).rejects.toThrow("OAuth callback timeout");

			expect(mockReceiver.cancel).toHaveBeenCalled();
		});

		test("P15: Cleanup on error (pending callback cancelled)", async () => {
			await prepare();

			mockReceiver.waitForCallback.mockRejectedValue(new Error("Timeout"));

			await expect(
				handler.waitForCallbackAndExchange(PROVIDER),
			).rejects.toThrow();

			expect(mockReceiver.cancel).toHaveBeenCalled();
		});

		test("Fails if prepareOAuthFlow not called first", async () => {
			await expect(
				handler.waitForCallbackAndExchange(PROVIDER),
			).rejects.toThrow(
				"OAuth flow not started - call prepareOAuthFlow first",
			);
		});
	});

	describe("completeOAuthFlow()", () => {
		test("P13: Chains prepare + browser + callback", async () => {
			const authorizeUrl = "https://idp.example.com/oauth/v2/authorize?...";
			const openBrowser = jest.fn();

			mockFetch.mockResolvedValueOnce(
				await mockFetchResponse(200, { authorize_url: authorizeUrl, state: "state_xyz" }),
			);
			mockReceiver.waitForCallback.mockResolvedValue(SESSION);

			const result = await handler.completeOAuthFlow(PROVIDER, openBrowser);

			expect(openBrowser).toHaveBeenCalledWith(authorizeUrl);
			expect(result.user.email).toBe("test@example.com");
			expect(result.token.token).toBe("access_token_abc");
		});
	});

	describe("destroy()", () => {
		test("Cancels a pending callback", async () => {
			await prepare();

			handler.destroy();

			expect(mockReceiver.cancel).toHaveBeenCalled();
		});

		test("Can be called multiple times", () => {
			expect(() => {
				handler.destroy();
				handler.destroy();
			}).not.toThrow();
		});
	});
});
