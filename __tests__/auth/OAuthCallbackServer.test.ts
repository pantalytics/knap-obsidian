/**
 * Tests for OAuthCallbackServer
 *
 * Tests the local HTTP callback server for OAuth flow.
 * Uses real Node.js http module for integration testing.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import * as http from "http";
import { OAuthCallbackServer } from "../../src/auth/OAuthCallbackServer";

// Mock curryLog to avoid debug output during tests
jest.mock("../../src/debug", () => ({
	curryLog: () => jest.fn(),
}));

describe("OAuthCallbackServer", () => {
	let server: OAuthCallbackServer;

	beforeEach(() => {
		server = new OAuthCallbackServer();
	});

	afterEach(() => {
		// Ensure server is stopped after each test
		server.stop();
	});

	describe("start()", () => {
		test("P1: Server starts on random port", async () => {
			const port = await server.start();

			expect(port).toBeGreaterThan(0);
			expect(port).toBeLessThan(65536);

			// Verify server is actually listening
			await expect(
				new Promise<void>((resolve, reject) => {
					const req = http.request(
						{
							hostname: "127.0.0.1",
							port: port,
							path: "/",
							method: "GET",
						},
						(res) => {
							expect(res.statusCode).toBe(200);
							resolve();
						},
					);
					req.on("error", reject);
					req.end();
				}),
			).resolves.toBeUndefined();
		});

		test("P2: Server stops cleanly", async () => {
			const port = await server.start();

			server.stop();

			// Verify server is no longer listening
			await expect(
				new Promise<void>((resolve, reject) => {
					const req = http.request(
						{
							hostname: "127.0.0.1",
							port: port,
							path: "/",
							method: "GET",
							timeout: 100,
						},
						() => {
							reject(new Error("Server should not be listening"));
						},
					);
					req.on("error", () => {
						// Expected - connection refused
						resolve();
					});
					req.end();
				}),
			).resolves.toBeUndefined();
		});

		test("P6: Double stop doesn't crash", async () => {
			await server.start();

			server.stop();
			expect(() => server.stop()).not.toThrow();
		});
	});

	describe("waitForCallback()", () => {
		test("P3: Callback with code+state resolves correctly", async () => {
			const port = await server.start();

			// Simulate OAuth callback in background
			const callbackPromise = server.waitForCallback(5000);

			// Send callback request with code and state
			const code = "test_authorization_code";
			const state = "test_state_value";

			await new Promise<void>((resolve, reject) => {
				const req = http.request(
					{
						hostname: "127.0.0.1",
						port: port,
						path: `/callback?code=${code}&state=${state}`,
						method: "GET",
					},
					(res) => {
						expect(res.statusCode).toBe(200);
						resolve();
					},
				);
				req.on("error", reject);
				req.end();
			});

			// Wait for callback to be processed
			const result = await callbackPromise;

			expect(result).toEqual({
				code,
				state,
			});
		});

		test("P4: Callback without code rejects", async () => {
			const port = await server.start();

			const callbackPromise = server.waitForCallback(5000);

			// Send callback request without code (await both in parallel)
			const [httpResult] = await Promise.all([
				new Promise<void>((resolve, reject) => {
					const req = http.request(
						{
							hostname: "127.0.0.1",
							port: port,
							path: `/callback?state=test_state`,
							method: "GET",
						},
						(res) => {
							expect(res.statusCode).toBe(400);
							resolve();
						},
					);
					req.on("error", reject);
					req.end();
				}),
				expect(callbackPromise).rejects.toThrow(
					"Invalid OAuth callback - missing code or state",
				),
			]);
		});

		test("P5: Timeout triggers rejection", async () => {
			await server.start();

			// Wait for callback with very short timeout
			const callbackPromise = server.waitForCallback(100);

			await expect(callbackPromise).rejects.toThrow(
				"OAuth callback timeout - no response received",
			);
		});
	});

	describe("edge cases", () => {
		test("waitForCallback() fails if server not started", async () => {
			await expect(server.waitForCallback()).rejects.toThrow("Server not started");
		});

		test("Callback without state rejects", async () => {
			const port = await server.start();

			const callbackPromise = server.waitForCallback(5000);

			// Send callback request without state (await both in parallel)
			await Promise.all([
				new Promise<void>((resolve, reject) => {
					const req = http.request(
						{
							hostname: "127.0.0.1",
							port: port,
							path: `/callback?code=test_code`,
							method: "GET",
						},
						(res) => {
							expect(res.statusCode).toBe(400);
							resolve();
						},
					);
					req.on("error", reject);
					req.end();
				}),
				expect(callbackPromise).rejects.toThrow(
					"Invalid OAuth callback - missing code or state",
				),
			]);
		});

		test("Multiple callbacks only resolve first one", async () => {
			const port = await server.start();

			const callbackPromise = server.waitForCallback(5000);

			// Send first callback
			await new Promise<void>((resolve, reject) => {
				const req = http.request(
					{
						hostname: "127.0.0.1",
						port: port,
						path: `/callback?code=first&state=state1`,
						method: "GET",
					},
					(res) => {
						expect(res.statusCode).toBe(200);
						resolve();
					},
				);
				req.on("error", reject);
				req.end();
			});

			const result = await callbackPromise;
			expect(result.code).toBe("first");

			// Second callback should still return 200 but won't affect result
			await new Promise<void>((resolve, reject) => {
				const req = http.request(
					{
						hostname: "127.0.0.1",
						port: port,
						path: `/callback?code=second&state=state2`,
						method: "GET",
					},
					(res) => {
						expect(res.statusCode).toBe(200);
						resolve();
					},
				);
				req.on("error", reject);
				req.end();
			});
		});

		test("Stop during waitForCallback cleans up", async () => {
			await server.start();

			const callbackPromise = server.waitForCallback(5000);

			// Stop server while waiting
			server.stop();

			// Promise may reject or just hang - we just ensure stop() doesn't crash
			try {
				await Promise.race([
					callbackPromise,
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error("Timeout")), 100),
					),
				]);
			} catch (error) {
				// Expected - either timeout or callback error
				expect(error).toBeDefined();
			}
		});
	});
});
