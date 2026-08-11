import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import {
	OAuthDeepLinkReceiver,
	OAUTH_CALLBACK_ACTION,
	OAUTH_RETURN_URL,
} from "../../src/auth/OAuthDeepLinkReceiver";

jest.mock("../../src/debug", () => ({
	curryLog: () => () => {},
}));

/** What the patched control plane appends to the return URL. */
const SESSION = {
	access_token: "access_abc",
	refresh_token: "refresh_abc",
	expires_in: "1800",
	user_id: "user-1",
	user_email: "someone@example.com",
	user_name: "Someone",
};

describe("OAuthDeepLinkReceiver", () => {
	let receiver: OAuthDeepLinkReceiver;

	beforeEach(() => {
		receiver = new OAuthDeepLinkReceiver();
	});

	test("the return URL is one fixed string", () => {
		// The whole point of the change: a loopback port varied per run and
		// could not be registered anywhere.
		expect(OAUTH_RETURN_URL).toBe(`obsidian://${OAUTH_CALLBACK_ACTION}`);
		expect(OAUTH_RETURN_URL).not.toMatch(/127\.0\.0\.1|localhost|:\d+/);
	});

	test("resolves with the session when the state matches", async () => {
		const waiting = receiver.waitForCallback("state_abc", 5000);
		expect(receiver.isWaiting).toBe(true);

		const consumed = receiver.handleCallback({
			...SESSION,
			state: "state_abc",
		});

		expect(consumed).toBe(true);
		await expect(waiting).resolves.toEqual({
			state: "state_abc",
			accessToken: "access_abc",
			refreshToken: "refresh_abc",
			expiresIn: 1800,
			userId: "user-1",
			userEmail: "someone@example.com",
			userName: "Someone",
		});
		expect(receiver.isWaiting).toBe(false);
	});

	test("P6-TR21: rejects a callback whose state does not match", async () => {
		// Anything on the machine can open an obsidian:// URL, so a callback
		// carrying the wrong state is somebody else's session or a forgery.
		const waiting = receiver.waitForCallback("state_ours", 5000);

		receiver.handleCallback({ ...SESSION, state: "state_theirs" });

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

	test("says so when the callback carries no session", async () => {
		// An unpatched control plane redirects here with the token in a cookie
		// this application cannot read, so the callback arrives empty.
		const waiting = receiver.waitForCallback("state_abc", 5000);
		receiver.handleCallback({ state: "state_abc" });
		await expect(waiting).rejects.toThrow("without a session");
	});

	test("ignores a callback when nothing is waiting", () => {
		expect(receiver.handleCallback({ ...SESSION, state: "s" })).toBe(false);
	});

	test("refuses a second concurrent flow rather than orphaning the first", async () => {
		const first = receiver.waitForCallback("state_one", 5000);
		await expect(receiver.waitForCallback("state_two", 5000)).rejects.toThrow(
			"already in progress",
		);

		// The first is still live and still the one that gets answered.
		receiver.handleCallback({ ...SESSION, state: "state_one" });
		await expect(first).resolves.toEqual(
			expect.objectContaining({ state: "state_one", accessToken: "access_abc" }),
		);
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
