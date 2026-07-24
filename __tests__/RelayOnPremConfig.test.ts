import { withUpdatedLastUserEmail } from "../src/RelayOnPremConfig";
import type { RelayOnPremSettings, RelayOnPremServer } from "../src/RelayOnPremConfig";

function makeServer(overrides: Partial<RelayOnPremServer> = {}): RelayOnPremServer {
	return {
		id: "server-1",
		name: "Server 1",
		controlPlaneUrl: "https://cp.example.com",
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
