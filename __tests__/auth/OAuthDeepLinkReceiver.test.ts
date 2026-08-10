import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import {
	OAuthDeepLinkReceiver,
	OAUTH_CALLBACK_ACTION,
	OAUTH_REDIRECT_URI,
} from "../../src/auth/OAuthDeepLinkReceiver";

jest.mock("../../src/debug", () => ({
	curryLog: () => () => {},
}));

describe("OAuthDeepLinkReceiver", () => {
	let receiver: OAuthDeepLinkReceiver;

	beforeEach(() => {
		receiver = new OAuthDeepLinkReceiver();
	});

	test("the redirect URI is one fixed string", () => {
		// The whole point of the change: a loopback port varied per run and
		// could not be registered at an IdP that matches exactly.
		expect(OAUTH_REDIRECT_URI).toBe(`obsidian://${OAUTH_CALLBACK_ACTION}`);
		expect(OAUTH_REDIRECT_URI).not.toMatch(/127\.0\.0\.1|localhost|:\d+/);
	});

	test("resolves with the code when the state matches", async () => {
		const waiting = receiver.waitForCallback("state_abc", 5000);
		expect(receiver.isWaiting).toBe(true);

		const consumed = receiver.handleCallback({
			code: "code_xyz",
			state: "state_abc",
		});

		expect(consumed).toBe(true);
		await expect(waiting).resolves.toEqual({
			code: "code_xyz",
			state: "state_abc",
		});
		expect(receiver.isWaiting).toBe(false);
	});

	test("P6-TR21: rejects a callback whose state does not match", async () => {
		// Anything on the machine can open an obsidian:// URL, so a callback
		// carrying the wrong state is somebody else's code or a forgery.
		const waiting = receiver.waitForCallback("state_ours", 5000);

		receiver.handleCallback({ code: "code_theirs", state: "state_theirs" });

		await expect(waiting).rejects.toThrow("state mismatch");
	});

	test("rejects when the IdP returns an error", async () => {
		const waiting = receiver.waitForCallback("state_abc", 5000);

		receiver.handleCallback({
			error: "access_denied",
			error_description: "user said no",
		});

		await expect(waiting).rejects.toThrow("access_denied");
	});

	test("rejects a callback missing its code", async () => {
		const waiting = receiver.waitForCallback("state_abc", 5000);
		receiver.handleCallback({ state: "state_abc" });
		await expect(waiting).rejects.toThrow("missing code or state");
	});

	test("ignores a callback when nothing is waiting", () => {
		expect(receiver.handleCallback({ code: "c", state: "s" })).toBe(false);
	});

	test("refuses a second concurrent flow rather than orphaning the first", async () => {
		const first = receiver.waitForCallback("state_one", 5000);
		await expect(receiver.waitForCallback("state_two", 5000)).rejects.toThrow(
			"already in progress",
		);

		// The first is still live and still the one that gets answered.
		receiver.handleCallback({ code: "code_one", state: "state_one" });
		await expect(first).resolves.toEqual({
			code: "code_one",
			state: "state_one",
		});
	});

	test("times out", async () => {
		jest.useFakeTimers();
		const waiting = receiver.waitForCallback("state_abc", 1000);
		const assertion = expect(waiting).rejects.toThrow("Timed out");
		jest.advanceTimersByTime(1001);
		await assertion;
		jest.useRealTimers();
		expect(receiver.isWaiting).toBe(false);
	});

	test("cancel rejects a flow in progress and is safe when idle", async () => {
		expect(() => receiver.cancel()).not.toThrow();

		const waiting = receiver.waitForCallback("state_abc", 5000);
		receiver.cancel();
		await expect(waiting).rejects.toThrow("cancelled");
		expect(receiver.isWaiting).toBe(false);
	});
});
