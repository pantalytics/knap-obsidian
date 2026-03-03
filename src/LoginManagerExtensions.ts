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
