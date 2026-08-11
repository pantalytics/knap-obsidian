/**
 * The Knap server, and the settings that hold it.
 *
 * There is one server and the plugin knows only that one (ADR-0033). Its
 * address is build-time configuration, not a text field and not a literal in
 * a file that ships: esbuild.config.mjs defines CONTROL_PLANE_URL, and
 * KNAP_CONTROL_PLANE_URL below is the only place the rest of the plugin reads
 * it from.
 *
 * The settings still carry a list of servers because the auth layer, the
 * shares and the shared folder records are all keyed by a server id. The list
 * holds exactly one entry, nothing can add a second, and the migration below
 * collapses anything older down to it.
 */

declare const CONTROL_PLANE_URL: string;

/** The id every share, folder record and stored credential is keyed by. */
export const KNAP_SERVER_ID = "knap-sync";

/** What the server is called on screen, the rare times it is named at all. */
export const KNAP_SERVER_NAME = "Knap Sync";

/** Where the plugin talks, fixed at build time. */
export const KNAP_CONTROL_PLANE_URL = CONTROL_PLANE_URL;

/**
 * A configured server. Only one is ever built, by knapServer() below.
 */
export interface RelayOnPremServer {
	/** Unique identifier for this server */
	id: string;

	/** Display name for the server */
	name: string;

	/** Control plane URL */
	controlPlaneUrl: string;

	/** Last signed-in email, for display */
	lastUserEmail?: string;

}

/**
 * Relay on-prem settings. One server, and the id of it.
 */
export interface RelayOnPremSettings {
	/**
	 * Enable relay-onprem mode (instead of System 3 cloud)
	 */
	enabled: boolean;

	/**
	 * The configured servers. Exactly one, always the Knap server.
	 */
	servers: RelayOnPremServer[];

	/**
	 * Server id used for new shares. Always the Knap server's.
	 */
	defaultServerId?: string;
}

/**
 * The Knap server, as the settings hold it. `lastUserEmail` survives a rebuild
 * against a different address, because it is the one field a person put there.
 * Everything else is build configuration.
 */
export function knapServer(lastUserEmail?: string): RelayOnPremServer {
	return {
		id: KNAP_SERVER_ID,
		name: KNAP_SERVER_NAME,
		controlPlaneUrl: KNAP_CONTROL_PLANE_URL,
		...(lastUserEmail ? { lastUserEmail } : {}),
	};
}

export const DEFAULT_RELAY_ONPREM_SETTINGS: RelayOnPremSettings = {
	// Knap Sync always uses relay-onprem mode (no System 3 cloud)
	enabled: true,
	servers: [knapServer()],
	defaultServerId: KNAP_SERVER_ID,
};

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

/**
 * Any settings shape this plugin has ever written: the legacy single server,
 * the multi-server list, or nothing at all.
 */
type StoredRelayOnPremSettings =
	| LegacyRelayOnPremSettings
	| RelayOnPremSettings
	| undefined
	| null;

/**
 * Result of settings migration, includes the renamed server ID for auth store
 * migration
 */
export interface MigrationResult {
	settings: RelayOnPremSettings;
	/** If a stored server was adopted as the Knap server, this is its old id */
	renamedServerId?: string;
	/** Whether any changes were made */
	changed: boolean;
}

function isMultiServer(
	settings: LegacyRelayOnPremSettings | RelayOnPremSettings,
): settings is RelayOnPremSettings {
	return "servers" in settings && Array.isArray(settings.servers);
}

/**
 * Pick which stored entry to carry forward. Its id is what the localStorage
 * credential and the shared folder records are keyed by, so adopting the right
 * one is what keeps somebody signed in across this migration.
 */
function adoptable(
	servers: RelayOnPremServer[],
	defaultServerId?: string,
): RelayOnPremServer | undefined {
	return (
		servers.find((s) => s.id === KNAP_SERVER_ID) ??
		servers.find((s) => s.controlPlaneUrl === KNAP_CONTROL_PLANE_URL) ??
		servers.find((s) => s.id === defaultServerId) ??
		servers[0]
	);
}

/**
 * Collapse whatever is stored down to the one Knap server.
 *
 * A person who added a second server through the list that used to be here
 * loses it, which is the decision rather than a side effect: there is nowhere
 * to reach it from any more, and its folders keep their own server id rather
 * than being quietly repointed at ours.
 */
export function migrateRelayOnPremSettings(
	oldSettings: StoredRelayOnPremSettings,
): MigrationResult {
	if (!oldSettings) {
		return { settings: DEFAULT_RELAY_ONPREM_SETTINGS, changed: true };
	}

	const stored: RelayOnPremServer | undefined = isMultiServer(oldSettings)
		? adoptable(oldSettings.servers, oldSettings.defaultServerId)
		: oldSettings.enabled && oldSettings.controlPlaneUrl
			? {
					id: KNAP_SERVER_ID,
					name: KNAP_SERVER_NAME,
					controlPlaneUrl: oldSettings.controlPlaneUrl,
					lastUserEmail: oldSettings.credentials?.email,
				}
			: undefined;

	const server = knapServer(stored?.lastUserEmail);
	const settings: RelayOnPremSettings = {
		enabled: true,
		servers: [server],
		defaultServerId: KNAP_SERVER_ID,
	};

	const renamedServerId =
		stored && stored.id !== KNAP_SERVER_ID ? stored.id : undefined;

	const changed =
		!isMultiServer(oldSettings) ||
		oldSettings.enabled !== true ||
		oldSettings.defaultServerId !== KNAP_SERVER_ID ||
		oldSettings.servers.length !== 1 ||
		JSON.stringify(oldSettings.servers[0]) !== JSON.stringify(server);

	return { settings, renamedServerId, changed };
}

/**
 * Minimum control-plane version this plugin version supports (TR-57). Bump it
 * whenever a breaking control-plane change ships that this plugin relies on: a
 * server below the floor says so at sign-in rather than failing later with
 * confusing 404s on an endpoint it does not have.
 *
 * NOTE (2026-07-22): control-plane's /server/info `version` field is
 * currently frozen at "0.1.0" and not bumped per release, so this floor is set
 * to that same baseline and the check never fires. It only becomes meaningful
 * once control-plane starts incrementing `version` on breaking changes.
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
 * Whether the server's reported version meets this plugin's compatibility
 * floor. A missing or empty version (a server predating the /server/info
 * version field) is treated as unsupported: it is the same "fails later with a
 * confusing error" case the check exists to catch.
 */
export function isServerVersionSupported(serverVersion: string | undefined | null): boolean {
	if (!serverVersion) return false;
	return compareSemver(serverVersion, MIN_SUPPORTED_SERVER_VERSION) >= 0;
}

/**
 * What to say when a server fails isServerVersionSupported(). Nobody reading
 * this runs the server, so it says what is happening rather than asking for
 * something they cannot do.
 */
export function serverCompatMessage(serverVersion: string | undefined | null): string {
	if (!serverVersion) {
		return "The server did not say which version it is running, and Knap Sync needs " +
			`${MIN_SUPPORTED_SERVER_VERSION} or newer. Nothing to fix on your side.`;
	}
	return `The server is on version ${serverVersion} and Knap Sync needs ` +
		`${MIN_SUPPORTED_SERVER_VERSION} or newer. Nothing to fix on your side, it will ` +
		"work once the server catches up.";
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
 * The Knap server. Named getDefaultServer for the callers that predate there
 * being only one of them.
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

