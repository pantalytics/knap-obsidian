/**
 * Integration-level regression test for TR-55.
 *
 * Drives the REAL MultiServerAuthManager + RelayOnPremAuthProvider +
 * RelayOnPremAuthStore singleton (only customFetch and window.localStorage
 * are mocked, at the true external boundary) — unlike
 * MultiServerAuthManager.test.ts, which mocks the store/provider wholesale
 * and can only prove `.clear()` was CALLED, not that it cleared the instance
 * a recreated provider actually reads through.
 *
 * An earlier version of the TR-55 fix passed the mocked-orchestration test
 * but failed this one: MultiServerAuthManager was constructing its own
 * `new RelayOnPremAuthStore(vaultName)` instead of sharing the
 * `getAuthStore(vaultName)` singleton RelayOnPremAuthProvider reads/writes
 * through — clearing via the wrong instance never touched the singleton's
 * in-memory storageFallback cache, which self-heals localStorage from that
 * cache on the next read. This test fails red against that bug and green
 * against the fix (verified via git stash before restoring).
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

jest.mock("../../src/debug", () => ({
	curryLog: () => jest.fn(),
	HasLogging: class HasLogging {
		protected debug = jest.fn();
		protected log = jest.fn();
		protected warn = jest.fn();
		protected error = jest.fn();
	},
}));

jest.mock("../../src/customFetch");
import { customFetch } from "../../src/customFetch";
const mockFetch = customFetch as jest.MockedFunction<typeof customFetch>;

jest.mock("../../src/auth/OAuthHandler");

const mockStorage = new Map<string, string>();
Object.defineProperty(global, "window", {
	value: {
		localStorage: {
			getItem: (key: string) => mockStorage.get(key) ?? null,
			setItem: (key: string, value: string) => mockStorage.set(key, value),
			removeItem: (key: string) => mockStorage.delete(key),
			get length() {
				return mockStorage.size;
			},
			key: (index: number) => [...mockStorage.keys()][index] ?? null,
			clear: () => mockStorage.clear(),
		},
		open: jest.fn(),
	},
	writable: true,
});

import { MultiServerAuthManager } from "../../src/auth/MultiServerAuthManager";
import { getAuthStore } from "../../src/auth/RelayOnPremAuthStore";
import type { RelayOnPremServer } from "../../src/RelayOnPremConfig";

function makeServer(overrides: Partial<RelayOnPremServer> = {}): RelayOnPremServer {
	return {
		id: "server-1",
		name: "Server 1",
		controlPlaneUrl: "https://old-host.example.com",
		isValidated: true,
		...overrides,
	};
}

describe("MultiServerAuthManager + RelayOnPremAuthStore integration (TR-55)", () => {
	const VAULT_NAME = "test-vault-tr55";
	const OLD_URL = "https://old-host.example.com";
	const NEW_URL = "https://new-host.example.com";
	const SERVER_ID = "server-1";

	beforeEach(() => {
		jest.clearAllMocks();
		mockStorage.clear();
		// The singleton persists across tests (module-level Map keyed by
		// vaultName) — must clear its in-memory fallback too, not just
		// window.localStorage, or state leaks between tests.
		getAuthStore(VAULT_NAME).clearAll();
	});

	test("changing a server's URL prevents the old host's session from being restored under the new URL", async () => {
		// Seed a valid (non-expired) session for server-1 under the OLD host,
		// via the exact singleton RelayOnPremAuthProvider reads through.
		getAuthStore(VAULT_NAME).save(SERVER_ID, {
			user: { id: "u1", email: "u1@example.com", name: "U1" },
			token: "old-access-token",
			expiresAt: Date.now() + 3600_000,
			refreshToken: "old-refresh-token",
		});

		const manager = new MultiServerAuthManager(VAULT_NAME, [
			makeServer({ id: SERVER_ID, controlPlaneUrl: OLD_URL }),
		]);
		await manager.getProvider(SERVER_ID)?.waitForRestore();
		expect(manager.getProvider(SERVER_ID)?.isLoggedIn()).toBe(true); // sanity: seed actually took

		manager.updateServer(makeServer({ id: SERVER_ID, controlPlaneUrl: NEW_URL }));
		const newProvider = manager.getProvider(SERVER_ID);
		await newProvider?.waitForRestore();

		expect(newProvider?.isLoggedIn()).toBe(false);
		expect(newProvider?.getCurrentUser()).toBeUndefined();

		// The strongest proof: no request carrying the old refresh token ever
		// reached the new host. Compare the exact origin (not a substring
		// prefix — startsWith(NEW_URL) would also match a spoofed host like
		// `${NEW_URL}.evil.com`) so this genuinely proves which host the
		// request went to.
		const newOrigin = new URL(NEW_URL).origin;
		for (const call of mockFetch.mock.calls) {
			const [url, init] = call as [string, RequestInit | undefined];
			if (new URL(url).origin === newOrigin) {
				expect(String(init?.body ?? "")).not.toContain("old-refresh-token");
			}
		}
	});

	test("keeping the same URL on update preserves the session (no spurious logout)", async () => {
		getAuthStore(VAULT_NAME).save(SERVER_ID, {
			user: { id: "u1", email: "u1@example.com", name: "U1" },
			token: "access-token",
			expiresAt: Date.now() + 3600_000,
			refreshToken: "refresh-token",
		});

		const manager = new MultiServerAuthManager(VAULT_NAME, [
			makeServer({ id: SERVER_ID, controlPlaneUrl: OLD_URL }),
		]);
		await manager.getProvider(SERVER_ID)?.waitForRestore();

		manager.updateServer(makeServer({ id: SERVER_ID, controlPlaneUrl: OLD_URL, name: "Renamed" }));
		const newProvider = manager.getProvider(SERVER_ID);
		await newProvider?.waitForRestore();

		expect(newProvider?.isLoggedIn()).toBe(true);
		expect(newProvider?.getCurrentUser()?.email).toBe("u1@example.com");
	});
});
