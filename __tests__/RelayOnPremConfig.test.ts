import { describe, test, expect } from "@jest/globals";
import { withUpdatedLastUserEmail } from "../src/RelayOnPremConfig";
import type { RelayOnPremSettings, RelayOnPremServer } from "../src/RelayOnPremConfig";
import {
	DEFAULT_RELAY_ONPREM_SETTINGS,
	KNAP_CONTROL_PLANE_URL,
	KNAP_SERVER_ID,
	KNAP_SERVER_NAME,
	MIN_SUPPORTED_SERVER_VERSION,
	compareSemver,
	isServerVersionSupported,
	knapServer,
	migrateRelayOnPremSettings,
	serverCompatMessage,
} from "../src/RelayOnPremConfig";

function makeServer(overrides: Partial<RelayOnPremServer> = {}): RelayOnPremServer {
	return {
		id: "server-1",
		name: "Server 1",
		controlPlaneUrl: "https://cp.tr.entire.vc",
		...overrides,
	};
}

function makeSettings(servers: RelayOnPremServer[]): RelayOnPremSettings {
	return {
		enabled: true,
		servers,
	};
}

describe("withUpdatedLastUserEmail", () => {
	test("sets lastUserEmail on the matching server", () => {
		const settings = makeSettings([makeServer({ id: "server-1" }), makeServer({ id: "server-2" })]);

		const updated = withUpdatedLastUserEmail(settings, "server-2", "user@example.com");

		expect(updated.servers.find((s) => s.id === "server-2")?.lastUserEmail).toBe(
			"user@example.com"
		);
	});

	test("leaves other servers untouched", () => {
		const settings = makeSettings([
			makeServer({ id: "server-1", lastUserEmail: "existing@example.com" }),
			makeServer({ id: "server-2" }),
		]);

		const updated = withUpdatedLastUserEmail(settings, "server-2", "new@example.com");

		expect(updated.servers.find((s) => s.id === "server-1")?.lastUserEmail).toBe(
			"existing@example.com"
		);
	});

	test("does not mutate the input settings object (safe for NamespacedSettings.update)", () => {
		const original = makeSettings([makeServer({ id: "server-1" })]);
		const snapshot = JSON.parse(JSON.stringify(original));

		withUpdatedLastUserEmail(original, "server-1", "user@example.com");

		expect(original).toEqual(snapshot);
	});

	test("returns the same settings reference when the server is not found", () => {
		const settings = makeSettings([makeServer({ id: "server-1" })]);

		const updated = withUpdatedLastUserEmail(settings, "does-not-exist", "user@example.com");

		expect(updated).toBe(settings);
	});

	test("preserves other settings fields (defaultServerId)", () => {
		const settings: RelayOnPremSettings = {
			...makeSettings([makeServer({ id: "server-1" })]),
			defaultServerId: "server-1",
		};

		const updated = withUpdatedLastUserEmail(settings, "server-1", "user@example.com");

		expect(updated.defaultServerId).toBe("server-1");
		expect(updated.enabled).toBe(true);
	});
});

/**
 * Tests for RelayOnPremConfig — TR-57 server version compatibility check.
 *
 * MIN_SUPPORTED_SERVER_VERSION is pinned to the control-plane's current
 * live baseline ("0.1.0", see the constant's own comment), so these tests
 * exercise the comparison logic against synthetic versions rather than
 * asserting on that literal value directly — the floor is expected to move.
 */

describe("compareSemver", () => {
	test("equal versions return 0", () => {
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
	});

	test("higher major wins regardless of minor/patch", () => {
		expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareSemver("1.9.9", "2.0.0")).toBeLessThan(0);
	});

	test("higher minor wins when major is equal", () => {
		expect(compareSemver("1.5.0", "1.4.9")).toBeGreaterThan(0);
		expect(compareSemver("1.4.9", "1.5.0")).toBeLessThan(0);
	});

	test("higher patch wins when major and minor are equal", () => {
		expect(compareSemver("1.2.5", "1.2.4")).toBeGreaterThan(0);
		expect(compareSemver("1.2.4", "1.2.5")).toBeLessThan(0);
	});

	test("missing/non-numeric segments are treated as 0", () => {
		expect(compareSemver("1.2", "1.2.0")).toBe(0);
		expect(compareSemver("1", "1.0.0")).toBe(0);
	});

	test("a leading v/V prefix is stripped, not treated as garbage", () => {
		expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
		expect(compareSemver("V1.2.3", "1.2.3")).toBe(0);
		expect(compareSemver("v2.0.0", "v1.9.9")).toBeGreaterThan(0);
	});
});

describe("isServerVersionSupported", () => {
	test("a version equal to the floor is supported", () => {
		expect(isServerVersionSupported(MIN_SUPPORTED_SERVER_VERSION)).toBe(true);
	});

	test("a version above the floor is supported", () => {
		const [major, minor, patch] = MIN_SUPPORTED_SERVER_VERSION.split(".").map(Number);
		expect(isServerVersionSupported(`${major}.${minor}.${patch + 1}`)).toBe(true);
		expect(isServerVersionSupported(`${major + 1}.0.0`)).toBe(true);
	});

	test("TR-57: a version below the floor is NOT supported", () => {
		expect(isServerVersionSupported("0.0.1")).toBe(false);
	});

	test("TR-57: a missing/empty version is NOT supported (pre-versioning server)", () => {
		expect(isServerVersionSupported(undefined)).toBe(false);
		expect(isServerVersionSupported(null)).toBe(false);
		expect(isServerVersionSupported("")).toBe(false);
	});
});

describe("serverCompatMessage", () => {
	test("mentions the server's reported version and the required floor", () => {
		const msg = serverCompatMessage("0.0.1");
		expect(msg).toContain("0.0.1");
		expect(msg).toContain(MIN_SUPPORTED_SERVER_VERSION);
	});

	test("has a distinct message for a server reporting no version at all", () => {
		const msg = serverCompatMessage(undefined);
		expect(msg).toContain(MIN_SUPPORTED_SERVER_VERSION);
		expect(msg).not.toContain("undefined");
	});

	test("does not ask the reader to update a server they do not run", () => {
		expect(serverCompatMessage("0.0.1").toLowerCase()).not.toContain("update the server");
	});
});

/**
 * One server, and the plugin knows only that one (ADR-0033). The address is
 * build-time configuration, so these assert against CONTROL_PLANE_URL as jest
 * defines it rather than a literal.
 */
describe("the one server", () => {
	test("the default settings hold exactly the Knap server, at the built address", () => {
		expect(DEFAULT_RELAY_ONPREM_SETTINGS.servers).toEqual([
			{ id: KNAP_SERVER_ID, name: "Knap", controlPlaneUrl: KNAP_CONTROL_PLANE_URL },
		]);
		expect(DEFAULT_RELAY_ONPREM_SETTINGS.defaultServerId).toBe(KNAP_SERVER_ID);
	});

	test("the built address is what the build defined, not a literal in the source", () => {
		// jest.config.js defines CONTROL_PLANE_URL as a test address. A source
		// file that hardcoded the production one would fail here.
		expect(KNAP_CONTROL_PLANE_URL).toBe("https://cp.knap.test");
	});

	test("knapServer carries an email through and leaves the key off without one", () => {
		expect(knapServer("someone@example.com").lastUserEmail).toBe("someone@example.com");
		expect(knapServer()).not.toHaveProperty("lastUserEmail");
	});
});

describe("migrateRelayOnPremSettings", () => {
	test("nothing stored yields the defaults", () => {
		const result = migrateRelayOnPremSettings(undefined);
		expect(result.settings).toEqual(DEFAULT_RELAY_ONPREM_SETTINGS);
		expect(result.changed).toBe(true);
		expect(result.renamedServerId).toBeUndefined();
	});

	test("settings already holding just the Knap server are left alone", () => {
		const result = migrateRelayOnPremSettings(DEFAULT_RELAY_ONPREM_SETTINGS);
		expect(result.changed).toBe(false);
		expect(result.settings.servers).toHaveLength(1);
	});

	test("a stored address from an older build is replaced by the built one", () => {
		const result = migrateRelayOnPremSettings({
			enabled: true,
			servers: [{ id: KNAP_SERVER_ID, name: "Knap", controlPlaneUrl: "https://cp.old.example" }],
			defaultServerId: KNAP_SERVER_ID,
		});
		expect(result.settings.servers[0].controlPlaneUrl).toBe(KNAP_CONTROL_PLANE_URL);
		expect(result.changed).toBe(true);
	});

	test("extra servers are dropped and the Knap one is kept", () => {
		const result = migrateRelayOnPremSettings({
			enabled: true,
			servers: [
				makeServer({ id: "someone-elses-relay", controlPlaneUrl: "https://cp.example.com" }),
				makeServer({ id: KNAP_SERVER_ID, controlPlaneUrl: KNAP_CONTROL_PLANE_URL, lastUserEmail: "me@example.com" }),
			],
			defaultServerId: "someone-elses-relay",
		});
		expect(result.settings.servers).toHaveLength(1);
		expect(result.settings.servers[0].id).toBe(KNAP_SERVER_ID);
		expect(result.settings.servers[0].lastUserEmail).toBe("me@example.com");
		expect(result.settings.defaultServerId).toBe(KNAP_SERVER_ID);
		expect(result.renamedServerId).toBeUndefined();
	});

	test("a server stored under a generated id is adopted, and reports its old id", () => {
		// main.ts moves the stored credential and the shared folder records
		// across on the strength of renamedServerId, so somebody signed in
		// before the upgrade is still signed in after it.
		const result = migrateRelayOnPremSettings({
			enabled: true,
			servers: [makeServer({ id: "cp-knap-test-443", controlPlaneUrl: KNAP_CONTROL_PLANE_URL, lastUserEmail: "me@example.com" })],
			defaultServerId: "cp-knap-test-443",
		});
		expect(result.renamedServerId).toBe("cp-knap-test-443");
		expect(result.settings.servers[0].id).toBe(KNAP_SERVER_ID);
		expect(result.settings.servers[0].lastUserEmail).toBe("me@example.com");
	});

	test("the legacy single-server shape carries its email across", () => {
		const result = migrateRelayOnPremSettings({
			enabled: true,
			controlPlaneUrl: "https://cp.old.example",
			credentials: { email: "me@example.com" },
		});
		expect(result.settings.servers).toEqual([
			{
				id: KNAP_SERVER_ID,
				name: "Knap",
				controlPlaneUrl: KNAP_CONTROL_PLANE_URL,
				lastUserEmail: "me@example.com",
			},
		]);
		expect(result.changed).toBe(true);
	});

	test("a disabled legacy shape still ends up on the Knap server", () => {
		const result = migrateRelayOnPremSettings({ enabled: false, controlPlaneUrl: "" });
		expect(result.settings).toEqual(DEFAULT_RELAY_ONPREM_SETTINGS);
	});
});

describe("what this vault syncs", () => {
	test("there is no setting for it, and a stale one does not come back", () => {
		// A vault syncs whole and nothing on this side records a preference
		// otherwise (ADR-0042). Settings written by a build that had the
		// toggle carry a syncMode; the migration must drop it rather than
		// keep a field nothing reads.
		const result = migrateRelayOnPremSettings({
			enabled: true,
			servers: [
				{
					id: KNAP_SERVER_ID,
					name: KNAP_SERVER_NAME,
					controlPlaneUrl: KNAP_CONTROL_PLANE_URL,
					syncMode: "folders",
				} as unknown as RelayOnPremServer,
			],
			defaultServerId: KNAP_SERVER_ID,
		});
		expect(result.settings.servers[0]).not.toHaveProperty("syncMode");
	});

	test("knapServer carries the email and nothing else a person set", () => {
		expect(knapServer()).not.toHaveProperty("lastUserEmail");
		expect(knapServer()).not.toHaveProperty("syncMode");
		expect(knapServer("a@b.test").lastUserEmail).toBe("a@b.test");
	});
});
