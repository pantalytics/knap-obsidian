import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import {
	HandoffReceiver,
	PAIRED_ACTION,
	challengeFor,
	newVerifier,
} from "../../src/knap/handoff";

jest.mock("../../src/debug", () => ({
	curryLog: () => () => {},
}));

describe("the deep link the credential arrives on", () => {
	let receiver: HandoffReceiver;

	beforeEach(() => {
		receiver = new HandoffReceiver();
	});

	test("the action carries no port and no host", () => {
		// Same property the OAuth callback needs, for a different reason: Knap
		// treats this as a constant rather than as a redirect it accepts, so a
		// varying string would simply not be reachable.
		expect(PAIRED_ACTION).not.toMatch(/127\.0\.0\.1|localhost|:\d+/);
	});

	test("resolves with the token when the state matches", async () => {
		const waiting = receiver.waitForCallback("state_abc", 5000);
		expect(receiver.isWaiting).toBe(true);

		const consumed = receiver.handleCallback({
			token: "tok_xyz",
			state: "state_abc",
		});

		expect(consumed).toBe(true);
		await expect(waiting).resolves.toEqual({
			token: "tok_xyz",
			state: "state_abc",
		});
		expect(receiver.isWaiting).toBe(false);
	});

	test("refuses a callback carrying somebody else's state", async () => {
		// TR-21. Anything on the machine can open an obsidian:// URL, so a
		// callback whose state is not the one we issued is a forgery or a
		// stray, and either way it must not be fed into our flow.
		const waiting = receiver.waitForCallback("state_ours", 5000);

		receiver.handleCallback({ token: "tok_theirs", state: "state_theirs" });

		await expect(waiting).rejects.toThrow("did not belong to this one");
	});

	test("passes Knap's own reason through rather than paraphrasing it", async () => {
		const waiting = receiver.waitForCallback("state_abc", 5000);
		receiver.handleCallback({
			state: "state_abc",
			error: "That sign-in link was already used or has expired.",
		});
		await expect(waiting).rejects.toThrow("already used or has expired");
	});

	test("a callback with no token is refused rather than resolved empty", async () => {
		const waiting = receiver.waitForCallback("state_abc", 5000);
		receiver.handleCallback({ state: "state_abc" });
		await expect(waiting).rejects.toThrow("came back incomplete");
	});

	test("refuses to run two sign-ins at once", async () => {
		const first = receiver.waitForCallback("state_1", 5000);
		await expect(receiver.waitForCallback("state_2", 5000)).rejects.toThrow(
			"already in progress",
		);

		// The first is still the one waiting, rather than having been silently
		// replaced by a second that would leave it hanging until it timed out.
		receiver.handleCallback({ token: "t", state: "state_1" });
		await expect(first).resolves.toMatchObject({ token: "t" });
	});

	test("ignores a callback when nothing is waiting", () => {
		expect(receiver.handleCallback({ token: "t", state: "s" })).toBe(false);
	});
});

describe("the challenge that makes a stolen token worthless", () => {
	test("a verifier is never the same twice", () => {
		const seen = new Set(Array.from({ length: 50 }, () => newVerifier()));
		expect(seen.size).toBe(50);
	});

	test("the challenge is a lowercase hex sha256, which is what Knap validates", async () => {
		const challenge = await challengeFor("a-verifier");
		expect(challenge).toMatch(/^[0-9a-f]{64}$/);
	});

	test("the same verifier always gives the same challenge", async () => {
		const verifier = newVerifier();
		expect(await challengeFor(verifier)).toBe(await challengeFor(verifier));
	});

	test("the challenge does not give the verifier away", async () => {
		// Stated as a test because the whole design rests on it: the browser
		// carries the challenge and the deep link carries the token, and
		// neither is enough to claim without the verifier that never left.
		const verifier = newVerifier();
		const challenge = await challengeFor(verifier);
		expect(challenge).not.toContain(verifier);
		expect(await challengeFor(verifier + "x")).not.toBe(challenge);
	});
});
