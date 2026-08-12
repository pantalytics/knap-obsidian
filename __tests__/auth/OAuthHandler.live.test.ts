/**
 * The plugin's own OAuth code against a real control plane.
 *
 * Skipped unless SPIKE_CP points at one. The rig that provides it lives in
 * knap-mcp-admin at `scripts/spikes/oauth_native_return_url/`: their control
 * plane at d3ae231 with both patches, plus a three-endpoint stub standing in
 * for Zitadel. Nothing here is mocked except `customFetch`, which is swapped
 * for node's fetch because the real one goes through Obsidian's `requestUrl`.
 *
 *   SPIKE_CP=http://127.0.0.1:8010 SPIKE_IDP=http://127.0.0.1:9099 npx jest live
 *
 * What it proves that the unit tests cannot: the two parameters this plugin
 * sends are the two that control plane accepts, and the query string it
 * redirects to is one the receiver can turn into a session.
 */

import { describe, test, expect, jest } from "@jest/globals";

const CP = process.env.SPIKE_CP ?? "";
const IDP = process.env.SPIKE_IDP ?? "http://127.0.0.1:9099";
const PROVIDER = "zitadel";

jest.mock("../../src/debug", () => ({
	curryLog: () => jest.fn(),
	HasLogging: class HasLogging {
		protected debug = jest.fn();
		protected log = jest.fn();
		protected warn = jest.fn();
		protected error = jest.fn();
	},
}));

// The real thing wraps Obsidian's requestUrl, which does not exist here.
jest.mock("../../src/customFetch", () => ({
	customFetch: (url: string, init?: RequestInit) =>
		fetch(url, { ...init, redirect: "manual" }),
}));

import { OAuthHandler } from "../../src/auth/OAuthHandler";
import { oauthDeepLinkReceiver } from "../../src/auth/OAuthDeepLinkReceiver";

const live = CP ? describe : describe.skip;

live("OAuthHandler against a live control plane", () => {
	test("signs in end to end and comes back with a usable session", async () => {
		const handler = new OAuthHandler(CP, "spike-server");

		// 1. The plugin asks the control plane to start a flow.
		const { authorizeUrl, returnUrl } = await handler.prepareOAuthFlow(PROVIDER);
		expect(returnUrl).toBe("obsidian://synced-vaults/oauth-callback");

		// The IdP is only ever told to come back to the control plane.
		const authorizeParams = new URL(authorizeUrl).searchParams;
		expect(authorizeParams.get("redirect_uri")).toBe(
			`${CP}/v1/auth/oauth/${PROVIDER}/callback`,
		);
		expect(authorizeUrl).not.toContain("obsidian");

		// 2. The browser's job: the IdP, then the control plane's callback.
		const atIdp = await fetch(
			authorizeUrl.replace("http://host.docker.internal:9099", IDP),
			{ redirect: "manual" },
		);
		const backToCp = atIdp.headers.get("location");
		expect(backToCp).toBeTruthy();

		const callback = await fetch(backToCp as string, { redirect: "manual" });
		const deepLink = callback.headers.get("location");
		expect(deepLink).toMatch(/^obsidian:\/\/synced-vaults\/oauth-callback\?/);

		// 3. Obsidian's job: hand those parameters to the protocol handler.
		const waiting = handler.waitForCallbackAndExchange(PROVIDER, 10_000);
		const params: Record<string, string> = {};
		new URL(deepLink as string).searchParams.forEach((value, key) => {
			params[key] = value;
		});
		expect(oauthDeepLinkReceiver.handleCallback(params)).toBe(true);

		const auth = await waiting;
		expect(auth.user.email).toBe("spike@example.com");
		expect(auth.token.token).toBeTruthy();
		expect(auth.refreshToken).toBeTruthy();

		// 4. And the token the plugin ended up holding actually opens a session.
		const me = await fetch(`${CP}/v1/auth/me`, {
			headers: { authorization: `Bearer ${auth.token.token}` },
		});
		expect(me.status).toBe(200);
		expect((await me.json()).email).toBe("spike@example.com");
	}, 30_000);

	test("a callback whose state is not ours is refused (TR-21)", async () => {
		const handler = new OAuthHandler(CP, "spike-server");
		await handler.prepareOAuthFlow(PROVIDER);

		const waiting = handler.waitForCallbackAndExchange(PROVIDER, 10_000);
		oauthDeepLinkReceiver.handleCallback({
			state: "not-the-state-we-were-issued",
			access_token: "somebody-elses-session",
		});

		await expect(waiting).rejects.toThrow("state mismatch");
	}, 30_000);
});
