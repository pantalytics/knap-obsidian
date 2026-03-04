/**
 * Relay On-Premise Configuration
 *
 * Configuration options for connecting to self-hosted relay-onprem instances
 * Supports multiple servers with independent authentication
 */

/** Well-known EVC Team Relay server */
export const EVC_SERVER_ID = "evc-team-relay";
export const EVC_CP_URL = "https://cp.tr.entire.vc";

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
	} catch {
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
	servers: [
		{
			id: EVC_SERVER_ID,
			name: "EVC Team Relay",
			controlPlaneUrl: EVC_CP_URL,
			isValidated: false,
		},
	],
	defaultServerId: EVC_SERVER_ID,
};

/**
 * Result of settings migration, includes renamed server IDs for auth store migration
 */
export interface MigrationResult {
	settings: RelayOnPremSettings;
	/** If an existing server was adopted as EVC, this is the old server ID */
	renamedServerId?: string;
	/** Whether any changes were made */
	changed: boolean;
}

/**
 * Migrate from legacy single-server settings to multi-server format
 */
export function migrateRelayOnPremSettings(
	oldSettings: LegacyRelayOnPremSettings | RelayOnPremSettings | undefined | null
): MigrationResult {
	// Already migrated or null
	if (!oldSettings) {
		return { settings: DEFAULT_RELAY_ONPREM_SETTINGS, changed: true };
	}

	// Check if already in new format (has servers array)
	if ("servers" in oldSettings && Array.isArray(oldSettings.servers)) {
		const orig = oldSettings;
		let changed = false;
		let renamedServerId: string | undefined;

		// Work on a shallow copy of servers to avoid mutating stored data
		let servers = orig.servers.map((s) => ({ ...s }));
		let defaultServerId = orig.defaultServerId;

		const evcByIdIdx = servers.findIndex((s) => s.id === EVC_SERVER_ID);
		// Find the BEST EVC-URL server: prefer one with isValidated or lastValidated (has auth)
		const evcByUrlIdxAll = servers
			.map((s, i) => ({ s, i }))
			.filter(({ s }) => s.controlPlaneUrl === EVC_CP_URL && s.id !== EVC_SERVER_ID);

		if (evcByIdIdx >= 0 && evcByUrlIdxAll.length > 0) {
			// Dedup: EVC by id exists AND there are duplicate(s) with same URL but different id.
			// Keep the richer duplicate (the one with auth/validation) under the EVC_SERVER_ID,
			// remove the empty stub.
			const richest = evcByUrlIdxAll.reduce((best, cur) =>
				(cur.s.isValidated || cur.s.lastValidated) ? cur : best, evcByUrlIdxAll[0]);
			const evcStub = servers[evcByIdIdx];
			const richServer = richest.s;

			// Merge: take all fields from the rich server, set id to EVC_SERVER_ID
			servers[evcByIdIdx] = {
				...richServer,
				id: EVC_SERVER_ID,
				name: richServer.name || evcStub.name || "EVC Team Relay",
			};
			renamedServerId = richServer.id;

			// Update defaultServerId if it pointed to the old id
			if (defaultServerId === richServer.id) {
				defaultServerId = EVC_SERVER_ID;
			}

			// Remove all duplicate-URL entries (keep only the one we merged into evcByIdIdx)
			const removeIds = new Set(evcByUrlIdxAll.map(({ s }) => s.id));
			servers = servers.filter((s) => !removeIds.has(s.id));
			changed = true;
		} else if (evcByIdIdx < 0) {
			// No EVC server by id — check if there's one by URL to adopt
			if (evcByUrlIdxAll.length > 0) {
				const richest = evcByUrlIdxAll.reduce((best, cur) =>
					(cur.s.isValidated || cur.s.lastValidated) ? cur : best, evcByUrlIdxAll[0]);
				renamedServerId = richest.s.id;
				servers[richest.i] = { ...richest.s, id: EVC_SERVER_ID };
				if (!servers[richest.i].name || servers[richest.i].name === new URL(EVC_CP_URL).hostname) {
					servers[richest.i].name = "EVC Team Relay";
				}
				if (defaultServerId === renamedServerId) {
					defaultServerId = EVC_SERVER_ID;
				}
				// Remove other duplicates
				if (evcByUrlIdxAll.length > 1) {
					const removeIds = new Set(
						evcByUrlIdxAll.filter(({ i }) => i !== richest.i).map(({ s }) => s.id)
					);
					servers = servers.filter((s) => !removeIds.has(s.id));
				}
				changed = true;
			} else {
				// No EVC server at all — prepend it
				servers.unshift({
					id: EVC_SERVER_ID,
					name: "EVC Team Relay",
					controlPlaneUrl: EVC_CP_URL,
					isValidated: false,
				});
				changed = true;
			}
		}

		if (!defaultServerId) {
			defaultServerId = EVC_SERVER_ID;
			changed = true;
		}

		return {
			settings: { ...orig, servers, defaultServerId },
			renamedServerId,
			changed,
		};
	}

	// Legacy format - migrate if enabled and has URL
	const legacy = oldSettings as LegacyRelayOnPremSettings;
	if (!legacy.enabled || !legacy.controlPlaneUrl) {
		return { settings: DEFAULT_RELAY_ONPREM_SETTINGS, changed: true };
	}

	// Create server from legacy settings
	const serverId = generateServerId(legacy.controlPlaneUrl);
	let serverName: string;
	try {
		serverName = new URL(legacy.controlPlaneUrl).hostname;
	} catch {
		serverName = "Relay Server";
	}

	return {
		settings: {
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
		},
		changed: true,
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
		} catch {
			errors.push("Control Plane URL is invalid");
		}
	}

	if (server.relayServerUrl) {
		try {
			const url = new URL(server.relayServerUrl);
			if (!url.protocol.match(/^wss?:$/)) {
				errors.push("Relay Server URL must use WS or WSS protocol");
			}
		} catch {
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
