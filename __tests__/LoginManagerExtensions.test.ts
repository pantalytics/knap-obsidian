/**
 * Unit tests: LoginManagerExtensions.loginWithOAuth2 (TR-10, #e7bca9fb)
 *
 * The bug: OAuth login call sites (RelayOnPremLoginModal, RelayOnPremServerList)
 * used to call `authProvider.loginWithOAuth2()` directly, bypassing LoginManager
 * entirely — LoginManager.user was never set and notifyListeners() was never
 * called, so main.ts's login listener (which gates _onLogin()/
 * loadRelayOnPremShares() on loginManager.loggedIn) never fired. Shares/live-sync
 * only started after a plugin reload happened to re-run the "already logged in"
 * restore path.
 *
 * LoginManager itself can't be unit-tested in this repo (it imports `pocketbase`,
 * an ESM-only package Jest can't parse under the current config — same wall
 * hit for Document.ts, see checkStale's TR-08 fix). This module
 * (LoginManagerExtensions.ts) has no such dependency, so the actual new logic —
 * turning an OAuth AuthResponse into a User the same way the password path
 * does — is fully testable here with a mock IAuthProvider.
 */

import { describe, test, expect, jest } from "@jest/globals";
import { loginWithOAuth2 } from "../src/LoginManagerExtensions";
import type { IAuthProvider, AuthResponse } from "../src/auth/IAuthProvider";

function makeAuthProvider(authResponse: AuthResponse): IAuthProvider {
	return {
		isLoggedIn: jest.fn(() => true),
		getCurrentUser: jest.fn(() => authResponse.user),
		getToken: jest.fn(() => authResponse.token.token),
		getValidToken: jest.fn(async () => authResponse.token.token),
		loginWithPassword: jest.fn(),
		loginWithOAuth2: jest.fn(async () => authResponse),
		refreshToken: jest.fn(),
		logout: jest.fn(),
		isTokenValid: jest.fn(() => true),
	} as unknown as IAuthProvider;
}

describe("loginWithOAuth2", () => {
	test("builds a User from the provider's AuthResponse", async () => {
		const authProvider = makeAuthProvider({
			user: { id: "u1", email: "dev@example.com", name: "Dev User", picture: "https://x/y.png" },
			token: { token: "jwt-abc", expiresAt: 999999 },
		});

		const user = await loginWithOAuth2(authProvider, "github");

		expect(authProvider.loginWithOAuth2).toHaveBeenCalledWith("github");
		expect(user.id).toBe("u1");
		expect(user.name).toBe("Dev User");
		expect(user.email).toBe("dev@example.com");
		expect(user.picture).toBe("https://x/y.png");
		expect(user.token).toBe("jwt-abc");
	});

	test("falls back to email when the provider gives no display name", async () => {
		const authProvider = makeAuthProvider({
			user: { id: "u2", email: "noname@example.com" },
			token: { token: "jwt-xyz", expiresAt: 999999 },
		});

		const user = await loginWithOAuth2(authProvider, "google");

		expect(user.name).toBe("noname@example.com");
		expect(user.picture).toBe("");
	});

	test("propagates a rejected OAuth attempt instead of returning a partial user", async () => {
		const authProvider: IAuthProvider = {
			isLoggedIn: jest.fn(() => false),
			getCurrentUser: jest.fn(() => undefined),
			getToken: jest.fn(() => undefined),
			getValidToken: jest.fn(async () => undefined),
			loginWithPassword: jest.fn(),
			loginWithOAuth2: jest.fn(async () => {
				throw new Error("popup closed");
			}),
			refreshToken: jest.fn(),
			logout: jest.fn(),
			isTokenValid: jest.fn(() => false),
		} as unknown as IAuthProvider;

		await expect(loginWithOAuth2(authProvider, "github")).rejects.toThrow(
			"popup closed",
		);
	});
});
