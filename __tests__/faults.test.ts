/**
 * Fault reporting (ADR-0071): the plugin says that it failed, and never what
 * it held. These tests assert on the wire format itself, because the wire is
 * the privacy promise: four keys and a count, and no message field anywhere,
 * however path-laden the error that came in.
 */

import { requestUrl } from "obsidian";
import {
	FaultReporter,
	SEND_EVERY_MS,
	faultsEndpoint,
	scrubFault,
} from "../src/faults";

const requestUrlMock = requestUrl as jest.Mock;

/** An error whose message is exactly the thing that must never leave. */
class VaultReadError extends Error {}
const PATHY = new VaultReadError(
	"ENOENT: Clients/Acme/2026 renewal.md not found in [[Projects/Acme]]",
);

function sentBodies(): string[] {
	return requestUrlMock.mock.calls.map((call) => call[0].body as string);
}

describe("faults", () => {
	beforeEach(() => {
		jest.useFakeTimers();
		requestUrlMock.mockReset();
		requestUrlMock.mockResolvedValue({ status: 204 });
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("posts to the panel origin at /faults", () => {
		expect(faultsEndpoint()).toBe("https://knap.test/faults");
	});

	it("sends exactly type, component, version, platform and count", async () => {
		const reporter = new FaultReporter();
		reporter.report("sync", PATHY);
		await jest.advanceTimersByTimeAsync(SEND_EVERY_MS);

		expect(requestUrlMock).toHaveBeenCalledTimes(1);
		const params = requestUrlMock.mock.calls[0][0];
		expect(params.url).toBe("https://knap.test/faults");
		expect(params.method).toBe("POST");

		const payload = JSON.parse(params.body as string);
		expect(Object.keys(payload)).toEqual(["faults"]);
		expect(payload.faults).toHaveLength(1);
		const fault = payload.faults[0];
		// The whole wire format. No message key, and nothing beside these five.
		expect(Object.keys(fault).sort()).toEqual([
			"component",
			"count",
			"platform",
			"type",
			"version",
		]);
		expect(fault).toEqual({
			type: "VaultReadError",
			component: "sync",
			version: "test", // GIT_TAG in the jest globals
			platform: "desktop-mac", // the mock Platform is a mac
			count: 1,
		});
	});

	it("never lets a path-bearing message reach the serialized payload", async () => {
		const reporter = new FaultReporter();
		reporter.report("sync", PATHY);
		reporter.report("tokens", new Error("token refresh failed for Notes/Secret plan.md"));
		await jest.advanceTimersByTimeAsync(SEND_EVERY_MS);

		const everything = sentBodies().join("\n");
		expect(everything.length).toBeGreaterThan(0);
		expect(everything).not.toContain("Acme");
		expect(everything).not.toContain("Secret");
		expect(everything).not.toContain(".md");
		expect(everything).not.toContain("ENOENT");
		expect(everything).not.toContain("message");
	});

	it("scrubs a non-Error to a stable stand-in, never a stringification", () => {
		const fault = scrubFault("auth", "Clients/Acme/renewal.md exploded");
		expect(fault.type).toBe("NonError");
		expect(JSON.stringify(fault)).not.toContain("Acme");
	});

	it("folds identical faults into one entry with a count", async () => {
		const reporter = new FaultReporter();
		reporter.report("sync", PATHY);
		reporter.report("sync", new VaultReadError("a different message, same shape"));
		reporter.report("tokens", new Error("plain"));
		await jest.advanceTimersByTimeAsync(SEND_EVERY_MS);

		expect(requestUrlMock).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(requestUrlMock.mock.calls[0][0].body as string);
		expect(payload.faults).toHaveLength(2);
		const folded = payload.faults.find(
			(f: { type: string }) => f.type === "VaultReadError",
		);
		expect(folded.count).toBe(2);
		const other = payload.faults.find((f: { type: string }) => f.type === "Error");
		expect(other.count).toBe(1);
	});

	it("sends at most one request per window, however many faults arrive", async () => {
		const reporter = new FaultReporter();
		for (let i = 0; i < 50; i++) {
			reporter.report("sync", new Error(`burst ${i}`));
		}
		await jest.advanceTimersByTimeAsync(SEND_EVERY_MS * 3);
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});

	it("makes no network call at all when the setting is off", async () => {
		const reporter = new FaultReporter();
		reporter.setEnabled(false);
		reporter.report("sync", PATHY);
		reporter.report("startup", new Error("boom"));
		await jest.advanceTimersByTimeAsync(SEND_EVERY_MS * 3);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("turning it off drops what was already queued", async () => {
		const reporter = new FaultReporter();
		reporter.report("sync", PATHY);
		reporter.setEnabled(false);
		await jest.advanceTimersByTimeAsync(SEND_EVERY_MS * 3);
		expect(requestUrlMock).not.toHaveBeenCalled();
	});

	it("drops silently on failure and never retries", async () => {
		requestUrlMock.mockRejectedValue(new Error("network down"));
		const reporter = new FaultReporter();
		reporter.report("sync", PATHY);
		await jest.advanceTimersByTimeAsync(SEND_EVERY_MS * 5);
		// One attempt, no retry loop, and nothing thrown into the test.
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});
});
