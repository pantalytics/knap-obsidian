import { withUpdatedLastUserEmail, findDuplicateServer } from "../src/RelayOnPremConfig";
import type { RelayOnPremSettings, RelayOnPremServer } from "../src/RelayOnPremConfig";

function makeServer(overrides: Partial<RelayOnPremServer> = {}): RelayOnPremServer {
	return {
		id: "server-1",
		name: "Server 1",
		controlPlaneUrl: "https://cp.tr.entire.vc",
		isValidated: true,
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

describe("findDuplicateServer", () => {
	test("finds a collision on matching generated id (same URL added twice)", () => {
		const existing = [makeServer({ id: "cp-tr-entire-vc-443" })];

		const duplicate = findDuplicateServer(
			existing,
			"cp-tr-entire-vc-443",
			"https://cp.tr.entire.vc"
		);

		expect(duplicate).toBe(existing[0]);
	});

	test("finds a collision on matching URL under a different id", () => {
		const existing = [
			makeServer({ id: "server-custom-id", controlPlaneUrl: "https://cp.tr.entire.vc" }),
		];

		const duplicate = findDuplicateServer(
			existing,
			"cp-tr-entire-vc-443", // freshly generated id, differs from the stored custom id
			"https://cp.tr.entire.vc"
		);

		expect(duplicate).toBe(existing[0]);
	});

	test("matches URLs that differ only by trailing slash or case", () => {
		const existing = [makeServer({ controlPlaneUrl: "https://CP.tr.entire.vc/" })];

		const duplicate = findDuplicateServer(existing, "some-new-id", "https://cp.tr.entire.vc");

		expect(duplicate).toBe(existing[0]);
	});

	test("returns undefined when there's no collision", () => {
		const existing = [makeServer({ id: "server-1", controlPlaneUrl: "https://cp.tr.entire.vc" })];

		const duplicate = findDuplicateServer(
			existing,
			"other-host-443",
			"https://other-host.example.com"
		);

		expect(duplicate).toBeUndefined();
	});

	test("returns undefined against an empty server list", () => {
		expect(findDuplicateServer([], "any-id", "https://cp.tr.entire.vc")).toBeUndefined();
	});
});
