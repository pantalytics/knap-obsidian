/**
 * Tests for EndpointManager — TR-58 root-cause confirmation.
 *
 * This build (see esbuild.config.mjs: apiUrl = authUrl = "") compiles no
 * System3/PocketBase backend URL at all — it's relay-onprem only. The only
 * way getApiUrl()/getAuthUrl() return a non-empty value is a successfully
 * validated custom tenant. These tests pin that default-empty behavior,
 * which is the precondition for the TR-58 finding (LoginManager falling
 * through to `new PocketBase("")` when relay-onprem is disabled).
 */

import { describe, test, expect } from "@jest/globals";
import { EndpointManager } from "../src/EndpointManager";
import type { NamespacedSettings } from "../src/SettingsStorage";
import type { EndpointSettings } from "../src/EndpointManager";

// EndpointManager's constructor stores `settings` but getApiUrl()/getAuthUrl()/
// getDefaultUrls() never read it — a minimal stub is enough for these tests.
const fakeSettings = {} as unknown as NamespacedSettings<EndpointSettings>;

describe("EndpointManager — compiled URL defaults (TR-58)", () => {
	test("getApiUrl() is empty by default — no System3 backend compiled into this build", () => {
		const manager = new EndpointManager(fakeSettings);
		expect(manager.getApiUrl()).toBe("");
	});

	test("getAuthUrl() is empty by default — no System3 backend compiled into this build", () => {
		const manager = new EndpointManager(fakeSettings);
		expect(manager.getAuthUrl()).toBe("");
	});

	test("getDefaultUrls() reports both compiled URLs as empty", () => {
		const manager = new EndpointManager(fakeSettings);
		const defaults = manager.getDefaultUrls();
		expect(defaults.apiUrl).toBe("");
		expect(defaults.authUrl).toBe("");
	});
});
