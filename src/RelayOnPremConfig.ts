/**
 * Relay On-Premise Configuration
 *
 * Configuration options for connecting to self-hosted relay-onprem instances
 * Supports multiple servers with independent authentication
 */

/**
 * Generate a unique server ID from URL
 */
export function generateServerId(controlPlaneUrl: string): string {
	try {
		const url = new URL(controlPlaneUrl);
		// Use hostname + port as unique identifier
		const hostPart = url.hostname.replace(/\./g, "-");
		const portPart = url.port || (url.protocol === "https:" ? "443" : "80");
		return `${hostPart}-${portPart}`;
	} catch (e) {
		// Fallback to timestamp-based ID if URL parsing fails
		return `server-${Date.now()}`;
	}
}

/**
 * Individual relay-onprem server configuration
 */
export interface RelayOnPremServer {
	/**
	 * Unique identifier for this server (derived from URL)
	 */
	id: string;

	/**
	 * Display name for the server
	 */
	name: string;

	/**
	 * Control plane URL (e.g., https://cp.example.com)
	 */
	controlPlaneUrl: string;

	/**
	 * Relay server URL (e.g., wss://relay.example.com)
	 * If not specified, will use the URL from token response
	 */
	relayServerUrl?: string;

	/**
	 * Last logged in user email (for display purposes)
	 */
	lastUserEmail?: string;

	/**
	 * Whether connection has been validated
	 */
	isValidated: boolean;

	/**
	 * Timestamp of last validation
	 */
	lastValidated?: number;
}

/**
 * Relay on-prem settings with support for multiple servers
 */
export interface RelayOnPremSettings {
	/**
	 * Enable relay-onprem mode (instead of System 3 cloud)
	 */
	enabled: boolean;

	/**
	 * List of configured servers
	 */
	servers: RelayOnPremServer[];

	/**
	 * Default server ID for new shares
	 */
	defaultServerId?: string;
}

/**
 * Legacy settings format (pre-multi-server)
 */
interface LegacyRelayOnPremSettings {
	enabled: boolean;
	controlPlaneUrl: string;
	relayServerUrl?: string;
	credentials?: {
		email: string;
	};
}

export const DEFAULT_RELAY_ONPREM_SETTINGS: RelayOnPremSettings = {
	// EVC Team Relay always uses relay-onprem mode (no System 3 cloud)
	enabled: true,
	servers: [],
	defaultServerId: undefined,
};

/**
 * Migrate from legacy single-server settings to multi-server format
 */
export function migrateRelayOnPremSettings(
	oldSettings: LegacyRelayOnPremSettings | RelayOnPremSettings | undefined | null
): RelayOnPremSettings {
	// Already migrated or null
	if (!oldSettings) {
		return DEFAULT_RELAY_ONPREM_SETTINGS;
	}

	// Check if already in new format (has servers array)
	if ("servers" in oldSettings && Array.isArray(oldSettings.servers)) {
		return oldSettings as RelayOnPremSettings;
	}

	// Legacy format - migrate if enabled and has URL
	const legacy = oldSettings as LegacyRelayOnPremSettings;
	if (!legacy.enabled || !legacy.controlPlaneUrl) {
		return DEFAULT_RELAY_ONPREM_SETTINGS;
	}

	// Create server from legacy settings
	const serverId = generateServerId(legacy.controlPlaneUrl);
	let serverName: string;
	try {
		serverName = new URL(legacy.controlPlaneUrl).hostname;
	} catch (e) {
		serverName = "Relay Server";
	}

	return {
		enabled: true,
		servers: [
			{
				id: serverId,
				name: serverName,
				controlPlaneUrl: legacy.controlPlaneUrl,
				relayServerUrl: legacy.relayServerUrl,
				lastUserEmail: legacy.credentials?.email,
				isValidated: true,
				lastValidated: Date.now(),
			},
		],
		defaultServerId: serverId,
	};
}

/**
 * Validate a single server configuration
 */
export function validateServerConfig(server: RelayOnPremServer): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	if (!server.id) {
		errors.push("Server ID is required");
	}

	if (!server.name) {
		errors.push("Server name is required");
	}

	if (!server.controlPlaneUrl) {
		errors.push("Control Plane URL is required");
	} else {
		try {
			const url = new URL(server.controlPlaneUrl);
			if (!url.protocol.match(/^https?:$/)) {
				errors.push("Control Plane URL must use HTTP or HTTPS protocol");
			}
		} catch (e) {
			errors.push("Control Plane URL is invalid");
		}
	}

	if (server.relayServerUrl) {
		try {
			const url = new URL(server.relayServerUrl);
			if (!url.protocol.match(/^wss?:$/)) {
				errors.push("Relay Server URL must use WS or WSS protocol");
			}
		} catch (e) {
			errors.push("Relay Server URL is invalid");
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Validate relay-onprem settings
 */
export function validateRelayOnPremSettings(settings: RelayOnPremSettings): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	// Validate each server
	for (const server of settings.servers) {
		const serverValidation = validateServerConfig(server);
		if (!serverValidation.valid) {
			errors.push(`Server "${server.name}": ${serverValidation.errors.join(", ")}`);
		}
	}

	// Check for duplicate IDs
	const ids = new Set<string>();
	for (const server of settings.servers) {
		if (ids.has(server.id)) {
			errors.push(`Duplicate server ID: ${server.id}`);
		}
		ids.add(server.id);
	}

	// Check defaultServerId exists
	if (settings.defaultServerId && settings.servers.length > 0) {
		const defaultExists = settings.servers.some((s) => s.id === settings.defaultServerId);
		if (!defaultExists) {
			errors.push("Default server ID does not match any configured server");
		}
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * Get server by ID from settings
 */
export function getServerById(
	settings: RelayOnPremSettings,
	serverId: string
): RelayOnPremServer | undefined {
	return settings.servers.find((s) => s.id === serverId);
}

/**
 * Get the default server or first available server
 */
export function getDefaultServer(settings: RelayOnPremSettings): RelayOnPremServer | undefined {
	if (settings.defaultServerId) {
		const defaultServer = getServerById(settings, settings.defaultServerId);
		if (defaultServer) {
			return defaultServer;
		}
	}
	return settings.servers[0];
}
