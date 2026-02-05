/**
 * Authentication Provider Factory
 *
 * Creates the appropriate auth provider based on settings
 * Supports both single-server (legacy) and multi-server configurations
 */

import type PocketBase from "pocketbase";
import type { BaseAuthStore } from "pocketbase";
import type { IAuthProvider } from "./IAuthProvider";
import { PocketBaseAuthAdapter } from "./PocketBaseAuthAdapter";
import { RelayOnPremAuthProvider } from "./RelayOnPremAuthProvider";
import type { RelayOnPremSettings, RelayOnPremServer } from "../RelayOnPremConfig";
import { getDefaultServer } from "../RelayOnPremConfig";
import type { User } from "../User";

export interface AuthProviderFactoryConfig {
	// For System 3 / PocketBase mode
	pb?: PocketBase;
	authStore?: BaseAuthStore;
	userGetter?: () => User | undefined;

	// For relay-onprem mode
	relayOnPremSettings?: RelayOnPremSettings;
	vaultName?: string;
	serverId?: string; // Optional: specific server ID for multi-server mode
}

/**
 * Create auth provider based on configuration
 * For multi-server setups, use createAuthProviderForServer instead
 */
export function createAuthProvider(config: AuthProviderFactoryConfig): IAuthProvider {
	// Check if relay-onprem mode is enabled
	if (config.relayOnPremSettings?.enabled) {
		if (!config.vaultName) {
			throw new Error("Vault name is required for relay-onprem mode");
		}

		// Multi-server mode: use servers array
		if (config.relayOnPremSettings.servers && config.relayOnPremSettings.servers.length > 0) {
			// Get the specific server or default server
			const server = config.serverId
				? config.relayOnPremSettings.servers.find((s) => s.id === config.serverId)
				: getDefaultServer(config.relayOnPremSettings);

			if (!server) {
				throw new Error(
					config.serverId
						? `Server ${config.serverId} not found`
						: "No relay-onprem servers configured"
				);
			}

			return new RelayOnPremAuthProvider({
				controlPlaneUrl: server.controlPlaneUrl,
				vaultName: config.vaultName,
				serverId: server.id,
			});
		}

		// Legacy single-server mode: use controlPlaneUrl directly
		// This shouldn't happen with migrated settings, but keep for safety
		throw new Error("No relay-onprem servers configured");
	}

	// Default to PocketBase mode
	if (!config.pb || !config.authStore || !config.userGetter) {
		throw new Error("PocketBase configuration is required for System 3 mode");
	}

	return new PocketBaseAuthAdapter(config.pb, config.authStore, config.userGetter);
}

/**
 * Create auth provider for a specific server
 */
export function createAuthProviderForServer(
	server: RelayOnPremServer,
	vaultName: string
): RelayOnPremAuthProvider {
	return new RelayOnPremAuthProvider({
		controlPlaneUrl: server.controlPlaneUrl,
		vaultName: vaultName,
		serverId: server.id,
	});
}

/**
 * Check if relay-onprem mode is enabled
 * For EVC Team Relay, this is always true (we don't support System 3 cloud)
 */
export function isRelayOnPremMode(settings: RelayOnPremSettings): boolean {
	// Always return true if enabled, even without servers configured
	// This ensures the relay-onprem UI is shown so users can add servers
	return settings.enabled;
}
