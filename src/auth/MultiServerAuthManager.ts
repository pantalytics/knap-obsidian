/**
 * Multi-Server Authentication Manager
 *
 * Manages multiple RelayOnPremAuthProviders, one per server.
 * Provides a unified interface for authentication across multiple relay-onprem servers.
 */

import { curryLog } from "../debug";
import type { RelayOnPremServer } from "../RelayOnPremConfig";
import type { AuthUser } from "./IAuthProvider";
import { RelayOnPremAuthProvider } from "./RelayOnPremAuthProvider";
import { RelayOnPremAuthStore } from "./RelayOnPremAuthStore";

export interface ServerAuthStatus {
	serverId: string;
	serverName: string;
	isLoggedIn: boolean;
	user?: AuthUser;
}

export class MultiServerAuthManager {
	private log = curryLog("[MultiServerAuthManager]");
	private providers: Map<string, RelayOnPremAuthProvider> = new Map();
	private vaultName: string;
	private authStore: RelayOnPremAuthStore;

	constructor(vaultName: string, servers: RelayOnPremServer[] = []) {
		this.vaultName = vaultName;
		this.authStore = new RelayOnPremAuthStore(vaultName);

		// Initialize providers for all configured servers
		for (const server of servers) {
			this.addServer(server);
		}
	}

	/**
	 * Add a server and create its auth provider
	 */
	addServer(server: RelayOnPremServer): void {
		if (this.providers.has(server.id)) {
			this.log(`Server ${server.id} already exists, skipping`);
			return;
		}

		this.log(`Adding server: ${server.name} (${server.id})`);
		const provider = new RelayOnPremAuthProvider({
			controlPlaneUrl: server.controlPlaneUrl,
			vaultName: this.vaultName,
			serverId: server.id,
		});

		this.providers.set(server.id, provider);
	}

	/**
	 * Remove a server and its auth provider
	 */
	removeServer(serverId: string): void {
		const provider = this.providers.get(serverId);
		if (provider) {
			this.log(`Removing server: ${serverId}`);
			// Clear auth data for this server
			this.authStore.clear(serverId);
			this.providers.delete(serverId);
		}
	}

	/**
	 * Update server configuration (recreates the provider)
	 */
	updateServer(server: RelayOnPremServer): void {
		this.log(`Updating server: ${server.name} (${server.id})`);
		// Remove old provider if exists
		this.providers.delete(server.id);
		// Create new provider with updated config
		this.addServer(server);
	}

	/**
	 * Wait for all providers to finish restoring auth from localStorage.
	 * Must be called before checking auth state to avoid race conditions.
	 */
	async waitForAllRestore(): Promise<void> {
		const promises: Promise<void>[] = [];
		for (const provider of this.providers.values()) {
			promises.push(provider.waitForRestore());
		}
		await Promise.all(promises);
		this.log(`All ${promises.length} providers restored`);
	}

	/**
	 * Get auth provider for a specific server
	 */
	getProvider(serverId: string): RelayOnPremAuthProvider | undefined {
		return this.providers.get(serverId);
	}

	/**
	 * Get all providers
	 */
	getAllProviders(): Map<string, RelayOnPremAuthProvider> {
		return this.providers;
	}

	/**
	 * Get list of server IDs that are currently logged in
	 */
	getLoggedInServerIds(): string[] {
		const loggedIn: string[] = [];
		for (const [serverId, provider] of this.providers) {
			if (provider.isLoggedIn()) {
				loggedIn.push(serverId);
			}
		}
		return loggedIn;
	}

	/**
	 * Get auth status for all servers
	 */
	getAuthStatus(servers: RelayOnPremServer[]): ServerAuthStatus[] {
		return servers.map((server) => {
			const provider = this.providers.get(server.id);
			return {
				serverId: server.id,
				serverName: server.name,
				isLoggedIn: provider?.isLoggedIn() ?? false,
				user: provider?.getCurrentUser(),
			};
		});
	}

	/**
	 * Login to a specific server
	 */
	async loginToServer(serverId: string, email: string, password: string): Promise<AuthUser> {
		const provider = this.providers.get(serverId);
		if (!provider) {
			throw new Error(`Server ${serverId} not found`);
		}

		this.log(`Logging in to server ${serverId} as ${email}`);
		const response = await provider.loginWithPassword(email, password);
		return response.user;
	}

	/**
	 * Logout from a specific server
	 */
	async logoutFromServer(serverId: string): Promise<void> {
		const provider = this.providers.get(serverId);
		if (!provider) {
			throw new Error(`Server ${serverId} not found`);
		}

		this.log(`Logging out from server ${serverId}`);
		await provider.logout();
	}

	/**
	 * Logout from all servers
	 */
	async logoutAll(): Promise<void> {
		this.log("Logging out from all servers");
		const promises: Promise<void>[] = [];
		for (const [serverId, provider] of this.providers) {
			if (provider.isLoggedIn()) {
				promises.push(
					provider.logout().catch((error: unknown) => {
						this.log(`Error logging out from ${serverId}:`, error);
					})
				);
			}
		}
		await Promise.all(promises);
	}

	/**
	 * Check if logged in to any server
	 */
	isLoggedInToAny(): boolean {
		for (const provider of this.providers.values()) {
			if (provider.isLoggedIn()) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Check if logged in to a specific server
	 */
	isLoggedInToServer(serverId: string): boolean {
		const provider = this.providers.get(serverId);
		return provider?.isLoggedIn() ?? false;
	}

	/**
	 * Get user for a specific server
	 */
	getUserForServer(serverId: string): AuthUser | undefined {
		const provider = this.providers.get(serverId);
		return provider?.getCurrentUser();
	}

	/**
	 * Get token for a specific server
	 */
	getTokenForServer(serverId: string): string | undefined {
		const provider = this.providers.get(serverId);
		return provider?.getToken();
	}

	/**
	 * Get a valid token for a specific server, refreshing if needed
	 */
	async getValidTokenForServer(serverId: string): Promise<string | undefined> {
		const provider = this.providers.get(serverId);
		return provider?.getValidToken();
	}

	/**
	 * Refresh token for a specific server
	 */
	async refreshTokenForServer(serverId: string): Promise<void> {
		const provider = this.providers.get(serverId);
		if (!provider) {
			throw new Error(`Server ${serverId} not found`);
		}

		if (!provider.isLoggedIn()) {
			throw new Error(`Not logged in to server ${serverId}`);
		}

		await provider.refreshToken();
	}

	/**
	 * Get number of configured servers
	 */
	getServerCount(): number {
		return this.providers.size;
	}
}
