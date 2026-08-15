import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import { requestUrl } from "obsidian";
import NetworkStatus from "../src/NetworkStatus";
import { MockTimeProvider } from "./mocks/MockTimeProvider";

const mockRequestUrl = requestUrl as jest.Mock;

describe("NetworkStatus (TR-26: offline detection dead when url is empty)", () => {
	let timeProvider: MockTimeProvider;

	beforeEach(() => {
		mockRequestUrl.mockReset();
		timeProvider = new MockTimeProvider();
	});

	test("start() with no url is a no-op — never polls, stays online", () => {
		const status = new NetworkStatus(timeProvider, "");
		status.start();

		timeProvider.setTime(timeProvider.getTime() + 60_000);

		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(status.online).toBe(true);
	});

	test("start() with a url polls on the interval", async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: { status: "ok" } });
		const status = new NetworkStatus(timeProvider, "https://cp.example.com/v1/health", 1000);
		status.start();

		timeProvider.setTime(timeProvider.getTime() + 1000);
		await Promise.resolve();

		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://cp.example.com/v1/health" }),
		);
	});

	test("updateUrl() from empty to a real url starts polling (deferred-start bug)", async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: { status: "ok" } });
		// Constructed before the relay-onprem default server resolved — exactly
		// what happens if start() ran while url was still "".
		const status = new NetworkStatus(timeProvider, "", 1000);
		status.start();

		timeProvider.setTime(timeProvider.getTime() + 5000);
		expect(mockRequestUrl).not.toHaveBeenCalled();

		status.updateUrl("https://cp.example.com/v1/health");
		timeProvider.setTime(timeProvider.getTime() + 1000);
		await Promise.resolve();

		expect(mockRequestUrl).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://cp.example.com/v1/health" }),
		);
	});

	test("offline/online callbacks fire around a failed then recovered check", async () => {
		const status = new NetworkStatus(timeProvider, "https://cp.example.com/v1/health", 1000);
		const onOffline = jest.fn();
		const onOnline = jest.fn();
		status.addEventListener("offline", onOffline);
		status.addEventListener("online", onOnline);

		mockRequestUrl.mockRejectedValueOnce(new Error("network down"));
		status.start();
		timeProvider.setTime(timeProvider.getTime() + 1000);
		await Promise.resolve();
		await Promise.resolve();

		expect(status.online).toBe(false);
		expect(onOffline).toHaveBeenCalledTimes(1);

		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { status: "ok" } });
		timeProvider.setTime(timeProvider.getTime() + 1000);
		await Promise.resolve();
		await Promise.resolve();

		expect(status.online).toBe(true);
		expect(onOnline).toHaveBeenCalledTimes(1);
	});

	test("stop() actually stops the polling, and start() can resume it", async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: { status: "ok" } });
		const status = new NetworkStatus(timeProvider, "https://cp.example.com/v1/health", 1000);
		status.start();

		timeProvider.setTime(timeProvider.getTime() + 1000);
		await Promise.resolve();
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);

		// stop() used window.clearInterval on a TimeProvider handle, which
		// cleared nothing: the poll kept running after stop.
		status.stop();
		timeProvider.setTime(timeProvider.getTime() + 5000);
		await Promise.resolve();
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);

		status.start();
		timeProvider.setTime(timeProvider.getTime() + 1000);
		await Promise.resolve();
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	test("destroy() stops the timer, so a torn-down instance cannot keep firing", async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: { status: "ok" } });
		const status = new NetworkStatus(timeProvider, "https://cp.example.com/v1/health", 1000);
		status.start();
		status.destroy();

		// After a plugin update the old bundle's instance is exactly this
		// object: destroyed, with its callback arrays nulled. A surviving
		// interval would fire into those nulls beside the new bundle.
		timeProvider.setTime(timeProvider.getTime() + 5000);
		await Promise.resolve();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});
});
