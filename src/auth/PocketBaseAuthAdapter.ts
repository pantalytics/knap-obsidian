/**
 * PocketBase Authentication Adapter
 *
 * This adapter wraps existing PocketBase authentication logic
 * to conform to the IAuthProvider interface. This maintains
 * full backward compatibility with System 3 mode.
 */

import type PocketBase from "pocketbase";
import type { BaseAuthStore } from "pocketbase";
import { curryLog } from "../debug";
import type { IAuthProvider, AuthUser, AuthResponse } from "./IAuthProvider";
import type { User } from "../User";

export class PocketBaseAuthAdapter implements IAuthProvider {
	private log = curryLog("[PocketBaseAuth]");

	constructor(
		private pb: PocketBase,
		private authStore: BaseAuthStore,
		private userGetter: () => User | undefined,
	) {}

	isLoggedIn(): boolean {
		return this.pb.authStore.isValid && this.userGetter() !== undefined;
	}

	getCurrentUser(): AuthUser | undefined {
		const user = this.userGetter();
		if (!user) {
			return undefined;
		}

		return {
			id: user.id,
			email: user.email,
			name: user.name,
			picture: user.picture,
		};
	}

	getToken(): string | undefined {
		return this.pb.authStore.token;
	}

	getValidToken(): Promise<string | undefined> {
		return Promise.resolve(this.pb.authStore.token);
	}

	loginWithPassword(email: string, password: string): Promise<AuthResponse> {
		return Promise.reject(new Error(
			"Password login is not supported in System 3 mode. Please use OAuth2 authentication."
		));
	}

	async loginWithOAuth2(provider: string): Promise<AuthResponse> {
		this.log(`OAuth2 login with provider: ${provider}`);

		try {
			await this.pb.collection("users").authWithOAuth2({
				provider: provider,
			});

			const user = this.userGetter();
			if (!user) {
				throw new Error("Failed to get user after OAuth2 authentication");
			}

			return {
				user: {
					id: user.id,
					email: user.email,
					name: user.name,
					picture: user.picture,
				},
				token: {
					token: this.pb.authStore.token,
					expiresAt: this.getTokenExpiry(),
				},
			};
		} catch (error: unknown) {
			this.log("OAuth2 login error:", error);
			throw error;
		}
	}

	async refreshToken(): Promise<AuthResponse> {
		this.log("Refreshing PocketBase token...");

		try {
			await this.pb.collection("users").authRefresh();

			const user = this.userGetter();
			if (!user) {
				throw new Error("Failed to get user after token refresh");
			}

			this.log("Token refreshed successfully");

			return {
				user: {
					id: user.id,
					email: user.email,
					name: user.name,
					picture: user.picture,
				},
				token: {
					token: this.pb.authStore.token,
					expiresAt: this.getTokenExpiry(),
				},
			};
		} catch (error: unknown) {
			this.log("Token refresh error:", error);
			throw error;
		}
	}

	logout(): Promise<void> {
		this.log("Logging out from PocketBase...");
		this.pb.cancelAllRequests();
		this.pb.authStore.clear();
		this.log("Logged out successfully");
		return Promise.resolve();
	}

	isTokenValid(): boolean {
		return this.pb.authStore.isValid;
	}

	/**
	 * Get token expiry from JWT
	 */
	private getTokenExpiry(): number {
		try {
			const token = this.pb.authStore.token;
			const [, payload] = token.split(".");
			const decodedPayload = JSON.parse(atob(payload));
			return (decodedPayload.exp || 0) * 1000; // Convert to milliseconds
		} catch (error: unknown) {
			this.log("Failed to decode token expiry:", error);
			return 0;
		}
	}
}
