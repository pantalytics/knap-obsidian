/**
 * LoginManager Extensions for Relay On-Premise Support
 *
 * This module contains extension methods for LoginManager that add
 * relay-onprem authentication support while maintaining backward compatibility.
 *
 * Usage: Import these methods and use them in LoginManager when relay-onprem mode is enabled.
 */

import { User } from "./User";
import type { IAuthProvider } from "./auth/IAuthProvider";
import { curryLog } from "./debug";

const log = curryLog("[LoginManagerExt]");

/**
 * Login with email and password (relay-onprem mode)
 */
export async function loginWithEmailPassword(
	authProvider: IAuthProvider,
	email: string,
	password: string,
): Promise<User> {
	log(`Logging in with email: ${email}`);

	try {
		const authResponse = await authProvider.loginWithPassword(email, password);

		const user = new User(
			authResponse.user.id,
			authResponse.user.name || authResponse.user.email,
			authResponse.user.email,
			authResponse.user.picture || "",
			authResponse.token.token,
		);

		log(`Successfully logged in as ${user.email}`);
		return user;
	} catch (error: unknown) {
		log("Login error:", error);
		throw error;
	}
}

/**
 * Login with OAuth2 (relay-onprem mode)
 */
export async function loginWithOAuth2(
	authProvider: IAuthProvider,
	provider: string,
): Promise<User> {
	log(`Logging in with OAuth2 provider: ${provider}`);

	try {
		const authResponse = await authProvider.loginWithOAuth2(provider);

		const user = new User(
			authResponse.user.id,
			authResponse.user.name || authResponse.user.email,
			authResponse.user.email,
			authResponse.user.picture || "",
			authResponse.token.token,
		);

		log(`Successfully logged in as ${user.email}`);
		return user;
	} catch (error: unknown) {
		log("OAuth2 login error:", error);
		throw error;
	}
}

/**
 * Refresh authentication token
 */
export async function refreshAuthToken(authProvider: IAuthProvider): Promise<User> {
	log("Refreshing auth token...");

	try {
		const authResponse = await authProvider.refreshToken();

		const user = new User(
			authResponse.user.id,
			authResponse.user.name || authResponse.user.email,
			authResponse.user.email,
			authResponse.user.picture || "",
			authResponse.token.token,
		);

		log("Token refreshed successfully");
		return user;
	} catch (error: unknown) {
		log("Token refresh error:", error);
		throw error;
	}
}

/**
 * Logout user
 */
export async function logoutUser(authProvider: IAuthProvider): Promise<void> {
	log("Logging out...");

	try {
		await authProvider.logout();
		log("Logged out successfully");
	} catch (error: unknown) {
		log("Logout error:", error);
		throw error;
	}
}

/**
 * Check if user is logged in
 */
export function isUserLoggedIn(authProvider: IAuthProvider): boolean {
	return authProvider.isLoggedIn();
}

/**
 * Decide what `LoginManager.user` should become after a login attempt
 * fails, given the value the field held immediately before the attempt
 * (TR-52 analog for `loginWithEmailAndPassword`, audit #96d804dd).
 *
 * The old behavior unconditionally cleared `this.user` on any login
 * failure — a failed RE-login (e.g. a typo'd password re-entered while
 * already logged in, for whatever reason) silently logged the user out of
 * a session that was working fine. Restoring the pre-attempt snapshot
 * fixes this: when there was no prior session (`previousUser` is
 * `undefined`), the restored value is `undefined` too, reproducing the old
 * (correct-in-that-case) behavior; when there was one, it survives the
 * failed attempt instead of being wiped.
 *
 * Safe to call unconditionally (no `hadValidSession` branch needed) only
 * because `loginWithEmailAndPassword`'s try block is a single `await` — on
 * failure `this.user` was never mutated before the catch runs, so there's
 * no partial-mutation state to reconcile. Contrast
 * `RelayOnPremAuthProvider.loginWithPassword` (TR-52, #914c2b9d), which
 * restores several fields individually because its step 1 can succeed and
 * mutate state before its step 2 fails.
 */
export function resolveUserAfterFailedLogin<TUser>(
	previousUser: TUser | undefined,
): TUser | undefined {
	return previousUser;
}

/**
 * Get current user from auth provider
 */
export function getCurrentUserFromProvider(authProvider: IAuthProvider): User | undefined {
	const authUser = authProvider.getCurrentUser();
	if (!authUser) {
		return undefined;
	}

	const token = authProvider.getToken();
	if (!token) {
		return undefined;
	}

	return new User(
		authUser.id,
		authUser.name || authUser.email,
		authUser.email,
		authUser.picture || "",
		token,
	);
}
