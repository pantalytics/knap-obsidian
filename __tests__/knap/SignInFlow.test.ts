/**
 * The sign-in orchestration: browser out, deep link in, token settled.
 * The server half is a fake; the whole chain runs for real in
 * knap-mcp-admin's cross-repo spike.
 */

import { KnapServer } from "../../src/knap/KnapServer";
import { SIGNIN_ACTION, SignInFlow } from "../../src/knap/SignInFlow";

function serverWhereCode(valid: string): KnapServer {
	return new KnapServer("https://knap.test", async (url, init) => {
		if (url.includes("/auth/plugin/exchange")) {
			const body = JSON.parse(String(init?.body));
			return body.code === valid
				? new Response(JSON.stringify({ token: "knap_tok" }), { status: 200 })
				: new Response("{}", { status: 400 });
		}
		return new Response("", { status: 404 });
	});
}

describe("SignInFlow", () => {
	it("keeps the synced-vaults identifier in the deep link action", () => {
		expect(SIGNIN_ACTION).toBe("synced-vaults/signin");
	});

	it("opens the browser, takes the deep link, and lands the token", async () => {
		const flow = new SignInFlow(serverWhereCode("c-1"), "Laptop");
		const opened: string[] = [];

		const tokenPromise = flow.begin((url) => opened.push(url));
		expect(opened).toEqual(["https://knap.test/auth/plugin/start"]);

		expect(flow.handleDeepLink({ code: "c-1" })).toBe(true);
		expect(await tokenPromise).toBe("knap_tok");
	});

	it("a stray deep link with nobody waiting is refused, not crashed on", () => {
		const flow = new SignInFlow(serverWhereCode("c-1"), "Laptop");
		expect(flow.handleDeepLink({ code: "c-1" })).toBe(false);
	});

	it("a rejected code fails the flow with the server's words", async () => {
		const flow = new SignInFlow(serverWhereCode("goed"), "Laptop");
		const promise = flow.begin(() => undefined);
		flow.handleDeepLink({ code: "opnieuw-gebruikt" });
		await expect(promise).rejects.toThrow(/already used or has expired/);
	});

	it("a second sign-in replaces the first instead of stacking", async () => {
		const flow = new SignInFlow(serverWhereCode("c-2"), "Laptop");
		const first = flow.begin(() => undefined);
		const second = flow.begin(() => undefined);

		await expect(first).rejects.toThrow(/newer sign-in/);
		flow.handleDeepLink({ code: "c-2" });
		expect(await second).toBe("knap_tok");
	});

	it("a deep link without a code fails cleanly", async () => {
		const flow = new SignInFlow(serverWhereCode("c-3"), "Laptop");
		const promise = flow.begin(() => undefined);
		flow.handleDeepLink({});
		await expect(promise).rejects.toThrow(/without a code/);
	});
});

describe("a deep link nobody is waiting for", () => {
	it("says so rather than dropping the code in silence", () => {
		const flow = new SignInFlow(serverWhereCode("c-1"), "Laptop");
		// Nothing started here: no begin(), so nothing is pending.
		expect(flow.handleDeepLink({ code: "c-1" })).toBe(false);
	});

	it("feeds a flow that did start here", async () => {
		const flow = new SignInFlow(serverWhereCode("c-1"), "Laptop");
		const waiting = flow.begin(() => {});
		expect(flow.handleDeepLink({ code: "c-1" })).toBe(true);
		await expect(waiting).resolves.toBe("knap_tok");
	});
});
