/**
 * Signing out, as the engine does it: sockets down, token handed back,
 * settings emptied.
 *
 * The plugin had no way out. Sign in, link, unlink -- and then the only way
 * to stop being signed in on a device was to uninstall, which leaves the
 * token in the tokens table opening `/sync` and `/mcp` for whoever has the
 * laptop next. So the local half is not the whole act, and neither is the
 * remote half: the two tests here are the two halves failing separately.
 */

import { KnapSync } from "../../src/knap/KnapSync";
import type { KnapLink } from "../../src/knap/KnapSync";
import type { FileStore } from "../../src/knap/VaultBinding";

/** Files are beside the point here: nothing in a sign-out touches them. */
const noFiles: FileStore = {
	read: async () => null,
	write: async () => {},
	remove: async () => {},
	rename: async () => {},
	listNotes: async () => [],
	onChange: () => () => {},
};

function syncWith(
	stored: KnapLink | null,
	fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
) {
	let held = stored;
	const sync = new KnapSync({
		serverUrl: "https://knap.test",
		deviceName: "Laptop",
		fetchFn,
		files: noFiles,
		load: () => held,
		save: async (value) => {
			held = value;
		},
	});
	return { sync, held: () => held };
}

const signedIn: KnapLink = { token: "knap_abc", cloudVaultId: "v1", cloudVaultName: "Demo" };

describe("signing out", () => {
	it("hands the token back and forgets the account and the link", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const { sync, held } = syncWith(signedIn, async (url, init) => {
			calls.push({ url, init });
			return new Response(null, { status: 204 });
		});

		expect(await sync.signOut()).toEqual({ endedRemotely: true });

		expect(calls[0].url).toBe("https://knap.test/auth/plugin/signout");
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer knap_abc",
		);
		// The link goes with the account: a remembered cloud vault without a
		// token is a settings row promising a sync that cannot happen.
		expect(held()).toBeNull();
		expect(sync.signedIn).toBe(false);
		expect(sync.linked).toBeNull();
		expect(sync.running).toBe(false);
	});

	it("still signs out on this device when nothing can be reached", async () => {
		const { sync, held } = syncWith(signedIn, async () => {
			throw new Error("offline");
		});

		// Somebody pressing this on a train is signing out. Refusing because
		// the network is gone would leave them signed in with an error.
		expect(await sync.signOut()).toEqual({ endedRemotely: false });
		expect(held()).toBeNull();
		expect(sync.signedIn).toBe(false);
	});

	it("says nothing to the server when there was no token to hand back", async () => {
		const calls: string[] = [];
		const { sync, held } = syncWith(null, async (url) => {
			calls.push(url);
			return new Response(null, { status: 204 });
		});

		expect(await sync.signOut()).toEqual({ endedRemotely: true });
		expect(calls).toEqual([]);
		expect(held()).toBeNull();
	});
});
