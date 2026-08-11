/**
 * Tests for RelayOnPremAuthProvider
 *
 * Tests authentication provider with mocked fetch and localStorage.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { RelayOnPremAuthProvider } from "../../src/auth/RelayOnPremAuthProvider";
import { getAuthStore } from "../../src/auth/RelayOnPremAuthStore";
import type { AuthResponse } from "../../src/auth/IAuthProvider";

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

jest.mock("../../src/auth/OAuthHandler");
import { OAuthHandler } from "../../src/auth/OAuthHandler";
const MockOAuthHandler = OAuthHandler as jest.MockedClass<typeof OAuthHandler>;

// Mock localStorage
const mockStorage = new Map<string, string>();
Object.defineProperty(global, "window", {
	value: {
		localStorage: {
			getItem: (key: string) => mockStorage.get(key) ?? null,
			setItem: (key: string, value: string) => mockStorage.set(key, value),
			removeItem: (key: string) => mockStorage.delete(key),
			get length() {
				return mockStorage.size;
			},
			key: (index: number) => [...mockStorage.keys()][index] ?? null,
			clear: () => mockStorage.clear(),
		},
		open: jest.fn(),
	},
	writable: true,
});

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

/**
 * Minimal unsigned JWT. Only the payload is ever read (decodeToken), so the
 * header and signature just need to be there for the split to line up.
 */
function jwt(payload: Record<string, unknown>): string {
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
	return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.signature`;
}

describe("RelayOnPremAuthProvider", () => {
	const CONTROL_PLANE_URL = "https://cp.example.com";
	const APP_ID = "test-app-id";
	const SERVER_ID = "server-123";

	let provider: RelayOnPremAuthProvider;

	beforeEach(async () => {
		jest.clearAllMocks();
		mockStorage.clear();

		// getAuthStore(appId) is a module-level singleton (by design —
		// RelayOnPremAuthStore.ts's own docs: "prevent race conditions when
		// multiple providers access storage simultaneously"). It keeps an
		// in-memory storageFallback cache alongside every successful write
		// as a resilience backup, and _storageGet migrates that fallback
		// back into localStorage whenever the real store reads empty — so
		// clearing only `mockStorage` (the fake localStorage) is NOT enough
		// test isolation: a previous test's successful login can leak
		// forward into this one via the singleton's fallback cache. Clear
		// it explicitly, same APP_ID every test reuses.
		getAuthStore(APP_ID).clearAll();

		provider = new RelayOnPremAuthProvider({
			controlPlaneUrl: CONTROL_PLANE_URL,
			appId: APP_ID,
			serverId: SERVER_ID,
		});

		// Wait for restore to complete
		await provider.waitForRestore();
	});

	describe("loginWithPassword()", () => {
		test("P16: Success flow", async () => {
			const loginData = {
				access_token: "test_access_token",
				token_type: "bearer" as const,
				refresh_token: "test_refresh_token",
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				name: "Test User",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, loginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			const result = await provider.loginWithPassword(
				"test@example.com",
				"password123",
			);

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/auth/login`,
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						email: "test@example.com",
						password: "password123",
					}),
				}),
			);

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/auth/me`,
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						Authorization: `Bearer ${loginData.access_token}`,
					}),
				}),
			);

			expect(result.user.email).toBe("test@example.com");
			expect(result.token.token).toBe("test_access_token");
			expect(provider.isLoggedIn()).toBe(true);
		});

		test("P17: Error clears auth", async () => {
			mockFetch.mockResolvedValue(
				await mockFetchResponse(401, { error: "Invalid credentials" }, false),
			);

			await expect(
				provider.loginWithPassword("test@example.com", "wrong_password"),
			).rejects.toThrow("Login failed");

			expect(provider.isLoggedIn()).toBe(false);
			expect(provider.getCurrentUser()).toBeUndefined();
			expect(provider.getToken()).toBeUndefined();
		});

		test("TR-52: A failed re-login while already logged in does NOT clear the existing valid session", async () => {
			// First, a real successful login.
			const loginData = {
				access_token: "original_token",
				token_type: "bearer" as const,
				refresh_token: "original_refresh_token",
				expires_in: 3600,
			};
			const userData = {
				id: "user-123",
				email: "test@example.com",
				name: "Test User",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};
			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, loginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			await provider.loginWithPassword("test@example.com", "correct_password");
			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getToken()).toBe("original_token");

			// Now a re-login attempt with a typo'd password fails.
			mockFetch.mockResolvedValue(
				await mockFetchResponse(401, { error: "Invalid credentials" }, false),
			);

			await expect(
				provider.loginWithPassword("test@example.com", "typo'd_password"),
			).rejects.toThrow("Login failed");

			// The ORIGINAL session must still be intact — not logged out.
			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getCurrentUser()?.email).toBe("test@example.com");
			expect(provider.getToken()).toBe("original_token");
		});

		test("TR-52: a re-login that fails AFTER step 1 (login) but at step 2 (fetch user info) restores the exact prior token, not a partial mix", async () => {
			// A boolean "don't clear" guard alone isn't enough here: step 1
			// (POST /auth/login) can succeed and mutate this.token/
			// storedRefreshToken/tokenExpiresAt before step 2 (GET /auth/me)
			// fails — leaving the OLD user identity paired with a NEW
			// (different-identity) token if the catch only skips the clear
			// instead of restoring the exact snapshot.
			const originalLoginData = {
				access_token: "original_token",
				token_type: "bearer" as const,
				refresh_token: "original_refresh_token",
				expires_in: 3600,
			};
			const originalUserData = {
				id: "user-A",
				email: "userA@example.com",
				name: "User A",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};
			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, originalLoginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, originalUserData));

			await provider.loginWithPassword("userA@example.com", "correct_password");
			expect(provider.getToken()).toBe("original_token");

			// Re-login as a DIFFERENT user: step 1 succeeds (new token
			// issued), step 2 (/auth/me) then fails.
			const partialLoginData = {
				access_token: "userB_token",
				token_type: "bearer" as const,
				refresh_token: "userB_refresh_token",
				expires_in: 3600,
			};
			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, partialLoginData))
				.mockResolvedValueOnce(
					await mockFetchResponse(500, { error: "server error" }, false),
				);

			await expect(
				provider.loginWithPassword("userB@example.com", "password"),
			).rejects.toThrow("Failed to fetch user info");

			// Must be the ORIGINAL user paired with the ORIGINAL token — never
			// userA's identity paired with userB's token.
			expect(provider.getCurrentUser()?.email).toBe("userA@example.com");
			expect(provider.getToken()).toBe("original_token");
			expect(provider.isLoggedIn()).toBe(true);
		});

		test("Saves auth to localStorage on success", async () => {
			const loginData = {
				access_token: "token",
				token_type: "bearer" as const,
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, loginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			await provider.loginWithPassword("test@example.com", "password123");

			const storageKey = `knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`;
			const stored = mockStorage.get(storageKey);
			expect(stored).toBeDefined();

			const parsed = JSON.parse(stored!);
			expect(parsed.user.email).toBe("test@example.com");
			expect(parsed.token).toBe("token");
		});
	});

	describe("loginWithOAuth2()", () => {
		test("P18: Stores refresh_token (regression test)", async () => {
			const mockOAuthHandler = {
				completeOAuthFlow: jest.fn(),
				destroy: jest.fn(),
			};

			MockOAuthHandler.mockImplementation(() => mockOAuthHandler as any);

			const mockAuthResponse: AuthResponse = {
				user: {
					id: "oauth-user-123",
					email: "oauth@example.com",
					name: "OAuth User",
				},
				token: {
					token: "oauth_access_token",
					expiresAt: Date.now() + 3600000,
				},
				refreshToken: "oauth_refresh_token",
			};

			mockOAuthHandler.completeOAuthFlow.mockResolvedValue(mockAuthResponse);

			const result = await provider.loginWithOAuth2("casdoor");

			expect(result).toEqual(mockAuthResponse);
			expect(provider.isLoggedIn()).toBe(true);

			// Check localStorage for refresh token
			const storageKey = `knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`;
			const stored = mockStorage.get(storageKey);
			expect(stored).toBeDefined();

			const parsed = JSON.parse(stored!);
			expect(parsed.refreshToken).toBe("oauth_refresh_token");
			expect(mockOAuthHandler.destroy).toHaveBeenCalled();
		});

		test("P19: Error clears auth", async () => {
			const mockOAuthHandler = {
				completeOAuthFlow: jest.fn(),
				destroy: jest.fn(),
			};

			MockOAuthHandler.mockImplementation(() => mockOAuthHandler as any);

			mockOAuthHandler.completeOAuthFlow.mockRejectedValue(
				new Error("OAuth flow failed"),
			);

			await expect(provider.loginWithOAuth2("casdoor")).rejects.toThrow(
				"OAuth flow failed",
			);

			expect(provider.isLoggedIn()).toBe(false);
			expect(mockOAuthHandler.destroy).toHaveBeenCalled();
		});

		test("TR-52: A failed OAuth2 re-login while already logged in does NOT clear the existing valid session", async () => {
			const successfulOAuthHandler = {
				completeOAuthFlow: jest.fn(),
				destroy: jest.fn(),
			};
			MockOAuthHandler.mockImplementation(() => successfulOAuthHandler as any);

			const mockAuthResponse: AuthResponse = {
				user: {
					id: "oauth-user-123",
					email: "oauth@example.com",
					name: "OAuth User",
				},
				token: {
					token: "original_oauth_token",
					expiresAt: Date.now() + 3600000,
				},
				refreshToken: "original_oauth_refresh_token",
			};
			successfulOAuthHandler.completeOAuthFlow.mockResolvedValue(mockAuthResponse);

			await provider.loginWithOAuth2("casdoor");
			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getToken()).toBe("original_oauth_token");

			// A second OAuth attempt (e.g. re-triggered for some other reason)
			// fails — the original session must survive it.
			const failingOAuthHandler = {
				completeOAuthFlow: jest.fn(),
				destroy: jest.fn(),
			};
			MockOAuthHandler.mockImplementation(() => failingOAuthHandler as any);
			failingOAuthHandler.completeOAuthFlow.mockRejectedValue(
				new Error("OAuth flow failed"),
			);

			await expect(provider.loginWithOAuth2("casdoor")).rejects.toThrow(
				"OAuth flow failed",
			);

			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getCurrentUser()?.email).toBe("oauth@example.com");
			expect(provider.getToken()).toBe("original_oauth_token");
		});

		test("Opens browser with window.open", async () => {
			const mockOAuthHandler = {
				completeOAuthFlow: jest.fn(),
				destroy: jest.fn(),
			};

			MockOAuthHandler.mockImplementation(() => mockOAuthHandler as any);

			const mockAuthResponse: AuthResponse = {
				user: {
					id: "user-123",
					email: "test@example.com",
				},
				token: {
					token: "token",
					expiresAt: Date.now() + 3600000,
				},
			};

			mockOAuthHandler.completeOAuthFlow.mockImplementation(
				async (provider, openBrowser) => {
					openBrowser("https://auth.example.com/authorize");
					return mockAuthResponse;
				},
			);

			await provider.loginWithOAuth2("casdoor");

			expect(window.open).toHaveBeenCalledWith(
				"https://auth.example.com/authorize",
				"_blank",
			);
		});
	});

	describe("refreshToken()", () => {
		test("P20: Refresh with refresh_token", async () => {
			// Set up initial auth with refresh token
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "old_token",
					expiresAt: Date.now() + 3600000,
					refreshToken: "refresh_token_xyz",
				}),
			);

			// Recreate provider to load from storage
			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			const refreshData = {
				access_token: "new_access_token",
				refresh_token: "new_refresh_token",
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, refreshData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			const result = await provider.refreshToken();

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/v1/auth/refresh`,
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						refresh_token: "refresh_token_xyz",
					}),
				}),
			);

			expect(result.token.token).toBe("new_access_token");
			expect(provider.isLoggedIn()).toBe(true);
		});

		test("P21: Refresh without refresh_token (legacy)", async () => {
			// Set up initial auth WITHOUT refresh token
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "current_token",
					expiresAt: Date.now() + 3600000,
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			const userData = {
				id: "user-123",
				email: "test@example.com",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch.mockResolvedValue(await mockFetchResponse(200, userData));

			const result = await provider.refreshToken();

			// Should call /auth/me to verify token
			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/auth/me`,
				expect.objectContaining({
					method: "GET",
					headers: expect.objectContaining({
						Authorization: "Bearer current_token",
					}),
				}),
			);

			expect(result.user.email).toBe("test@example.com");
			expect(provider.isLoggedIn()).toBe(true);
		});

		test("P22: Error clears auth", async () => {
			// Set up initial auth
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
					refreshToken: "refresh_token",
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			mockFetch.mockResolvedValue(
				await mockFetchResponse(401, { error: "Invalid refresh token" }, false),
			);

			await expect(provider.refreshToken()).rejects.toThrow("Token refresh failed");

			expect(provider.isLoggedIn()).toBe(false);
			expect(provider.getCurrentUser()).toBeUndefined();
		});

		test("TR-28: calls onSessionExpired when the refresh token is rejected (401/403)", async () => {
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
					refreshToken: "refresh_token",
				}),
			);

			const onSessionExpired = jest.fn();
			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
				onSessionExpired,
			});
			await provider.waitForRestore();

			mockFetch.mockResolvedValue(
				await mockFetchResponse(401, { error: "Invalid refresh token" }, false),
			);

			await expect(provider.refreshToken()).rejects.toThrow("Token refresh failed");

			expect(onSessionExpired).toHaveBeenCalledTimes(1);
		});

		test("TR-28: does NOT call onSessionExpired on a network/server error (auth stays valid for retry)", async () => {
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
					refreshToken: "refresh_token",
				}),
			);

			const onSessionExpired = jest.fn();
			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
				onSessionExpired,
			});
			await provider.waitForRestore();

			mockFetch.mockResolvedValue(
				await mockFetchResponse(500, { error: "Internal server error" }, false),
			);

			await expect(provider.refreshToken()).rejects.toThrow();

			expect(onSessionExpired).not.toHaveBeenCalled();
			// Auth kept for retry — the whole point of the network/server-error branch.
			expect(provider.getCurrentUser()).toBeDefined();
		});

		test("Throws if no active session", async () => {
			await expect(provider.refreshToken()).rejects.toThrow(
				"No active session to refresh",
			);
		});
	});

	describe("restoreAuth()", () => {
		test("P23: Restore with valid token", async () => {
			const expiresAt = Date.now() + 3600000;
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "restored@example.com" },
					token: "stored_token",
					expiresAt,
					refreshToken: "refresh_token",
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getCurrentUser()?.email).toBe("restored@example.com");
			expect(provider.getToken()).toBe("stored_token");
		});

		test("P24: Restore with expired token + refresh", async () => {
			const expiredAt = Date.now() - 1000; // Expired 1 second ago
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "expired_token",
					expiresAt: expiredAt,
					refreshToken: "refresh_token_xyz",
				}),
			);

			const refreshData = {
				access_token: "new_token",
				refresh_token: "new_refresh",
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, refreshData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isLoggedIn()).toBe(true);
			expect(provider.getToken()).toBe("new_token");
		});

		test("P25: Restore with expired + no refresh clears", async () => {
			const expiredAt = Date.now() - 1000;
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "expired_token",
					expiresAt: expiredAt,
					// No refreshToken
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isLoggedIn()).toBe(false);
			expect(provider.getCurrentUser()).toBeUndefined();
		});

		test("P26: Restore with corrupted data", async () => {
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				"invalid json{",
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isLoggedIn()).toBe(false);
		});
	});

	describe("isTokenValid()", () => {
		test("P27: 5-minute buffer", async () => {
			const now = Date.now();

			// Token expires in 4 minutes (less than 5-minute buffer)
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: now + 4 * 60 * 1000,
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isTokenValid()).toBe(false);

			// Token expires in 6 minutes (more than 5-minute buffer)
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: now + 6 * 60 * 1000,
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isTokenValid()).toBe(true);
		});

		test("Returns false if no token", () => {
			expect(provider.isTokenValid()).toBe(false);
		});

		// #14: a flat 5-minute buffer is only safe while it is shorter than
		// the token it guards. An access token with a 5-minute TTL was
		// "expired" from the instant it was minted, so every caller asking for
		// a token kicked off another refresh — and every rotation left another
		// 30-day session behind on the control plane.
		test("#14: a short-lived token is valid when freshly minted", async () => {
			const nowSec = Math.floor(Date.now() / 1000);
			const shortLived = jwt({ iat: nowSec, exp: nowSec + 300 }); // 5-minute TTL

			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: shortLived,
					expiresAt: (nowSec + 300) * 1000,
					refreshToken: "refresh_token",
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isTokenValid()).toBe(true);
		});

		test("#14: a short-lived token still expires inside its final quarter", async () => {
			const nowSec = Math.floor(Date.now() / 1000);
			// Minted 4½ minutes ago with a 5-minute TTL: 30s left, buffer is 75s.
			const shortLived = jwt({ iat: nowSec - 270, exp: nowSec + 30 });

			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: shortLived,
					expiresAt: (nowSec + 30) * 1000,
					refreshToken: "refresh_token",
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isTokenValid()).toBe(false);
		});

		test("#14: a long-lived token keeps the flat 5-minute buffer", async () => {
			const nowSec = Math.floor(Date.now() / 1000);
			// 24-hour TTL: a quarter of that is way over the cap, so the cap wins.
			// 4 minutes left is inside the 5-minute buffer.
			const longLived = jwt({ iat: nowSec - 86_160, exp: nowSec + 240 });

			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: longLived,
					expiresAt: (nowSec + 240) * 1000,
					refreshToken: "refresh_token",
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			expect(provider.isTokenValid()).toBe(false);
		});
	});

	// #14: one login, one session. Every one of these paths used to be able to
	// put a second POST /v1/auth/refresh on the wire carrying the same refresh
	// token, and a control plane that rotates on refresh answers both.
	describe("refreshToken() single-flight (#14)", () => {
		function loggedInStorage() {
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
					refreshToken: "refresh_token",
				}),
			);
		}

		test("concurrent callers share one refresh request", async () => {
			loggedInStorage();
			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			mockFetch.mockImplementation((url) =>
				String(url).includes("/v1/auth/refresh")
					? mockFetchResponse(200, {
							access_token: "new_access_token",
							refresh_token: "new_refresh_token",
							expires_in: 3600,
						})
					: mockFetchResponse(200, { id: "user-123", email: "test@example.com" }),
			);

			const [a, b, c] = await Promise.all([
				provider.refreshToken(),
				provider.refreshToken(),
				provider.refreshToken(),
			]);

			const refreshCalls = mockFetch.mock.calls.filter(([url]) =>
				String(url).includes("/v1/auth/refresh"),
			);
			expect(refreshCalls).toHaveLength(1);
			// Everyone gets the same fresh token, not a stale or half-written one.
			expect(a.token.token).toBe("new_access_token");
			expect(b.token.token).toBe("new_access_token");
			expect(c.token.token).toBe("new_access_token");
		});

		test("a later refresh is not blocked by an earlier finished one", async () => {
			loggedInStorage();
			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			mockFetch.mockImplementation((url) =>
				String(url).includes("/v1/auth/refresh")
					? mockFetchResponse(200, {
							access_token: "new_access_token",
							refresh_token: "new_refresh_token",
							expires_in: 3600,
						})
					: mockFetchResponse(200, { id: "user-123", email: "test@example.com" }),
			);

			await provider.refreshToken();
			await provider.refreshToken();

			const refreshCalls = mockFetch.mock.calls.filter(([url]) =>
				String(url).includes("/v1/auth/refresh"),
			);
			expect(refreshCalls).toHaveLength(2);
		});

		test("getValidToken() does not replay a refresh that failed ambiguously", async () => {
			// Expired access token + a refresh token: getValidToken() has to
			// go to the network. This is the path that used to run
			// refreshTokenWithRetry — 3 attempts at 0/1s/3s, retrying anything
			// that was not a 401/403.
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "expired_token",
					expiresAt: Date.now() - 1000,
					refreshToken: "refresh_token",
				}),
			);

			// A 503 is exactly the ambiguous case: customFetch turns a reset
			// connection into one of these, and the rotation may already have
			// been applied server-side before the reset. Replaying it mints a
			// second 30-day session.
			mockFetch.mockResolvedValue(
				await mockFetchResponse(503, { error: "Service Unavailable" }, false),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			// restoreAuth() already tried once; count only what getValidToken does.
			mockFetch.mockClear();

			await provider.getValidToken();

			const refreshCalls = mockFetch.mock.calls.filter(([url]) =>
				String(url).includes("/v1/auth/refresh"),
			);
			expect(refreshCalls).toHaveLength(1);
		});
	});

	// #14, the measurement itself: five user_sessions rows in 67 seconds off
	// one sign-in — 08:09:27, :45, 08:10:02, :09, :34 — every one of them a
	// 30-day credential. The gaps (18s, 17s, 7s, 25s) are the cadence of the
	// plugin's own control-plane traffic, not of any retry it can run: every
	// retry path is capped at three attempts and finishes within seconds.
	//
	// What produces one row per operation is this class. Every control-plane
	// request re-derives its bearer token through getValidToken(), which mints
	// a new session whenever isTokenValid() says no — and a flat five-minute
	// buffer said no for the entire life of a token that lives five minutes.
	describe("#14: one sign-in, one session", () => {
		/** 08:09:27 on the day of the measurement — the first row. */
		const SIGN_IN = Date.UTC(2026, 7, 11, 8, 9, 27);
		/** The four later rows, as offsets in seconds from the sign-in. */
		const LATER_ROWS = [18, 35, 42, 67];

		function wireControlPlane(accessToken: string, expiresIn: number) {
			mockFetch.mockImplementation((url) => {
				const target = String(url);
				if (target.includes("/auth/login")) {
					return mockFetchResponse(200, {
						access_token: accessToken,
						token_type: "bearer",
						refresh_token: "refresh_token",
						expires_in: expiresIn,
					});
				}
				if (target.includes("/v1/auth/refresh")) {
					return mockFetchResponse(200, {
						access_token: "rotated_access_token",
						refresh_token: "rotated_refresh_token",
						expires_in: expiresIn,
					});
				}
				return mockFetchResponse(200, { id: "user-123", email: "test@example.com" });
			});
		}

		const sessionsMinted = () =>
			mockFetch.mock.calls.filter(([url]) => {
				const target = String(url);
				return target.includes("/auth/login") || target.includes("/v1/auth/refresh");
			}).length;

		test("operations across the measured 67 seconds mint one session, not five", async () => {
			const clock = jest.spyOn(Date, "now").mockReturnValue(SIGN_IN);
			try {
				// A five-minute access token — the case a flat five-minute
				// buffer cannot represent at all.
				wireControlPlane("opaque_access_token", 300);

				await provider.loginWithPassword("test@example.com", "password123");
				expect(sessionsMinted()).toBe(1);

				for (const offset of LATER_ROWS) {
					clock.mockReturnValue(SIGN_IN + offset * 1000);
					// Stands in for a control-plane operation: getHeaders() in
					// RelayOnPremShareClient and requestToken() in
					// RelayOnPremTokenProvider both go through this call.
					expect(await provider.getValidToken()).toBe("opaque_access_token");
				}

				expect(sessionsMinted()).toBe(1);
			} finally {
				clock.mockRestore();
			}
		});

		test("the session is still refreshed once the token is genuinely near expiry", async () => {
			const clock = jest.spyOn(Date, "now").mockReturnValue(SIGN_IN);
			try {
				wireControlPlane("opaque_access_token", 300);
				await provider.loginWithPassword("test@example.com", "password123");

				// Four minutes in: 60s left against a 75s buffer. Proactive
				// refresh has to still happen, or the fix trades duplicate
				// sessions for requests sent on an expiring token.
				clock.mockReturnValue(SIGN_IN + 240 * 1000);
				expect(await provider.getValidToken()).toBe("rotated_access_token");
				expect(sessionsMinted()).toBe(2);
			} finally {
				clock.mockRestore();
			}
		});

		// `iat` is optional (RFC 7519 §4.1.6). Scaling the buffer off it alone
		// leaves every token that omits it on the flat five minutes, which is
		// the bug — so the stated `expires_in` has to carry the same weight.
		test("a token carrying no iat is bounded by its stated lifetime", async () => {
			const clock = jest.spyOn(Date, "now").mockReturnValue(SIGN_IN);
			try {
				const noIat = jwt({ exp: Math.floor(SIGN_IN / 1000) + 300, sub: "user-123" });
				wireControlPlane(noIat, 300);

				await provider.loginWithPassword("test@example.com", "password123");

				clock.mockReturnValue(SIGN_IN + 67 * 1000);
				expect(provider.isTokenValid()).toBe(true);
				expect(await provider.getValidToken()).toBe(noIat);
				expect(sessionsMinted()).toBe(1);
			} finally {
				clock.mockRestore();
			}
		});
	});

	describe("logout()", () => {
		test("P28: Success", async () => {
			// Set up logged in state
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			mockFetch.mockResolvedValue(await mockFetchResponse(200, {}));

			await provider.logout();

			expect(mockFetch).toHaveBeenCalledWith(
				`${CONTROL_PLANE_URL}/auth/logout`,
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						Authorization: "Bearer token",
					}),
				}),
			);

			expect(provider.isLoggedIn()).toBe(false);
			expect(provider.getCurrentUser()).toBeUndefined();
			expect(provider.getToken()).toBeUndefined();
		});

		test("P29: Network error still clears local state", async () => {
			mockStorage.set(
				`knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`,
				JSON.stringify({
					user: { id: "user-123", email: "test@example.com" },
					token: "token",
					expiresAt: Date.now() + 3600000,
				}),
			);

			provider = new RelayOnPremAuthProvider({
				controlPlaneUrl: CONTROL_PLANE_URL,
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await provider.waitForRestore();

			mockFetch.mockRejectedValue(new Error("Network error"));

			await expect(provider.logout()).resolves.toBeUndefined();

			expect(provider.isLoggedIn()).toBe(false);
		});
	});

	describe("persistAuth()", () => {
		test("P30: Saves correctly", async () => {
			const loginData = {
				access_token: "test_token",
				token_type: "bearer" as const,
				refresh_token: "refresh",
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				name: "Test User",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, loginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			await provider.loginWithPassword("test@example.com", "password");

			const storageKey = `knap-sync_onprem_auth_${APP_ID}_${SERVER_ID}`;
			const stored = mockStorage.get(storageKey);
			expect(stored).toBeDefined();

			const parsed = JSON.parse(stored!);
			expect(parsed.user.id).toBe("user-123");
			expect(parsed.user.email).toBe("test@example.com");
			expect(parsed.user.name).toBe("Test User");
			expect(parsed.token).toBe("test_token");
			expect(parsed.refreshToken).toBe("refresh");
			expect(parsed.expiresAt).toBeGreaterThan(Date.now());
		});
	});

	describe("URL normalization", () => {
		test("Handles trailing slashes in control plane URL", async () => {
			const providerWithSlash = new RelayOnPremAuthProvider({
				controlPlaneUrl: "https://cp.example.com/",
				appId: APP_ID,
				serverId: SERVER_ID,
			});
			await providerWithSlash.waitForRestore();

			const loginData = {
				access_token: "token",
				token_type: "bearer" as const,
				expires_in: 3600,
			};

			const userData = {
				id: "user-123",
				email: "test@example.com",
				is_admin: false,
				created_at: "2024-01-01T00:00:00Z",
			};

			mockFetch
				.mockResolvedValueOnce(await mockFetchResponse(200, loginData))
				.mockResolvedValueOnce(await mockFetchResponse(200, userData));

			await providerWithSlash.loginWithPassword("test@example.com", "password");

			expect(mockFetch).toHaveBeenCalledWith(
				"https://cp.example.com/auth/login",
				expect.anything(),
			);
		});
	});
});
