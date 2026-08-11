/**
 * Knap Sync server configuration
 *
 * Configuration options for connecting to self-hosted relay-onprem instances
 * Supports multiple servers with independent authentication
 */

/** Well-known Knap relay server */
export const KNAP_SERVER_ID = "knap-sync";
export const KNAP_CP_URL = "https://cp.knap.pantalytics.com";

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
	// Knap Sync always uses relay-onprem mode (no System 3 cloud)
	enabled: true,
	servers: [
		{
			id: KNAP_SERVER_ID,
			name: "Knap Sync",
			controlPlaneUrl: KNAP_CP_URL,
			isValidated: false,
		},
	],
	defaultServerId: KNAP_SERVER_ID,
};

/**
 * Result of settings migration, includes renamed server IDs for auth store migration
 */
export interface MigrationResult {
	settings: RelayOnPremSettings;
	/** If an existing server was adopted as the well-known Knap server, this is the old server ID */
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

		const knapByIdIdx = servers.findIndex((s) => s.id === KNAP_SERVER_ID);
		// Find the BEST well-known-URL server: prefer one with isValidated or lastValidated (has auth)
		const knapByUrlIdxAll = servers
			.map((s, i) => ({ s, i }))
			.filter(({ s }) => s.controlPlaneUrl === KNAP_CP_URL && s.id !== KNAP_SERVER_ID);

		if (knapByIdIdx >= 0 && knapByUrlIdxAll.length > 0) {
			// Dedup: the well-known id exists AND there are duplicate(s) with same URL but different id.
			// Keep the richer duplicate (the one with auth/validation) under the KNAP_SERVER_ID,
			// remove the empty stub.
			const richest = knapByUrlIdxAll.reduce((best, cur) =>
				(cur.s.isValidated || cur.s.lastValidated) ? cur : best, knapByUrlIdxAll[0]);
			const knapStub = servers[knapByIdIdx];
			const richServer = richest.s;

			// Merge: take all fields from the rich server, set id to KNAP_SERVER_ID
			servers[knapByIdIdx] = {
				...richServer,
				id: KNAP_SERVER_ID,
				name: richServer.name || knapStub.name || "Knap Sync",
			};
			renamedServerId = richServer.id;

			// Update defaultServerId if it pointed to the old id
			if (defaultServerId === richServer.id) {
				defaultServerId = KNAP_SERVER_ID;
			}

			// Remove all duplicate-URL entries (keep only the one we merged into knapByIdIdx)
			const removeIds = new Set(knapByUrlIdxAll.map(({ s }) => s.id));
			servers = servers.filter((s) => !removeIds.has(s.id));
			changed = true;
		} else if (knapByIdIdx < 0) {
			// No well-known server by id — check if there's one by URL to adopt
			if (knapByUrlIdxAll.length > 0) {
				const richest = knapByUrlIdxAll.reduce((best, cur) =>
					(cur.s.isValidated || cur.s.lastValidated) ? cur : best, knapByUrlIdxAll[0]);
				renamedServerId = richest.s.id;
				servers[richest.i] = { ...richest.s, id: KNAP_SERVER_ID };
				if (!servers[richest.i].name || servers[richest.i].name === new URL(KNAP_CP_URL).hostname) {
					servers[richest.i].name = "Knap Sync";
				}
				if (defaultServerId === renamedServerId) {
					defaultServerId = KNAP_SERVER_ID;
				}
				// Remove other duplicates
				if (knapByUrlIdxAll.length > 1) {
					const removeIds = new Set(
						knapByUrlIdxAll.filter(({ i }) => i !== richest.i).map(({ s }) => s.id)
					);
					servers = servers.filter((s) => !removeIds.has(s.id));
				}
				changed = true;
			} else {
				// No well-known server at all — prepend it
				servers.unshift({
					id: KNAP_SERVER_ID,
					name: "Knap Sync",
					controlPlaneUrl: KNAP_CP_URL,
					isValidated: false,
				});
				changed = true;
			}
		}

		if (!defaultServerId) {
			defaultServerId = KNAP_SERVER_ID;
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
 * Minimum control-plane server version this plugin version supports (TR-57).
 * Bump this whenever a breaking control-plane API change ships that this
 * plugin relies on — a server below the floor gets a clear "please update"
 * notice at connect time instead of failing later with confusing unversioned
 * 404s once the plugin calls an endpoint the server doesn't have.
 *
 * NOTE (2026-07-22): control-plane's /server/info `version` field is
 * currently frozen at "0.1.0" and not bumped per release (checked live
 * against cp.tr.entire.vc) — this floor is set to that same baseline so the
 * live EVC server isn't false-flagged. The mechanism only becomes
 * meaningful once control-plane starts incrementing `version` on breaking
 * changes; that's a separate, cross-repo, product-lead call — flagged as a
 * follow-up, not fixed here.
 */
export const MIN_SUPPORTED_SERVER_VERSION = "0.1.0";

/**
 * Compare two bare semver strings (major.minor.patch — no pre-release/build
 * metadata, matching this project's version convention). A leading "v"/"V"
 * (e.g. "v1.2.3") is stripped before parsing.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * Missing or non-numeric segments are treated as 0.
 */
export function compareSemver(a: string, b: string): number {
	const parse = (v: string): [number, number, number] => {
		const parts = v.replace(/^v/i, "").split(".");
		return [0, 1, 2].map((i) => parseInt(parts[i], 10) || 0) as [number, number, number];
	};
	const [aMajor, aMinor, aPatch] = parse(a);
	const [bMajor, bMinor, bPatch] = parse(b);
	if (aMajor !== bMajor) return aMajor - bMajor;
	if (aMinor !== bMinor) return aMinor - bMinor;
	return aPatch - bPatch;
}

/**
 * Whether a server's reported version meets this plugin's compatibility
 * floor. A missing/empty version (server predates the /server/info version
 * field entirely) is treated as unsupported — it's the same "will fail
 * later with a confusing error" failure mode this check exists to catch.
 */
export function isServerVersionSupported(serverVersion: string | undefined | null): boolean {
	if (!serverVersion) return false;
	return compareSemver(serverVersion, MIN_SUPPORTED_SERVER_VERSION) >= 0;
}

/**
 * Human-readable message for a server that fails isServerVersionSupported().
 */
export function serverCompatMessage(serverVersion: string | undefined | null): string {
	if (!serverVersion) {
		return "This server doesn't report a version — it may be too old for this plugin version. Please update the server.";
	}
	return `This server is running version ${serverVersion}, older than this plugin requires (minimum ${MIN_SUPPORTED_SERVER_VERSION}). Please update the server.`;
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

/**
 * Return a new settings object with the given server's lastUserEmail set,
 * for persisting via NamespacedSettings.update(). Leaves settings unchanged
 * (same reference) if the server isn't found, so callers can skip a no-op
 * write by comparing references.
 */
export function withUpdatedLastUserEmail(
	settings: RelayOnPremSettings,
	serverId: string,
	email: string
): RelayOnPremSettings {
	if (!getServerById(settings, serverId)) {
		return settings;
	}
	return {
		...settings,
		servers: settings.servers.map((s) =>
			s.id === serverId ? { ...s, lastUserEmail: email } : s
		),
	};
}

function normalizeControlPlaneUrl(url: string): string {
	return url.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Find an existing server that would collide with a proposed add — same id
 * (generateServerId is deterministic per URL, so re-adding the same URL
 * produces the same id) or same URL under a different id (e.g. the server's
 * own self-reported id differs from generateServerId's output). Returns
 * undefined when there's no collision, i.e. the add is safe.
 */
export function findDuplicateServer(
	servers: RelayOnPremServer[],
	candidateId: string,
	candidateUrl: string
): RelayOnPremServer | undefined {
	const normalizedCandidate = normalizeControlPlaneUrl(candidateUrl);
	return servers.find(
		(s) => s.id === candidateId || normalizeControlPlaneUrl(s.controlPlaneUrl) === normalizedCandidate
	);
}
