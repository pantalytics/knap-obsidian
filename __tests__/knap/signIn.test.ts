import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { requestUrl } from "obsidian";

import { handoffReceiver } from "../../src/knap/handoff";
import { signIn, type SignInDeps } from "../../src/knap/signIn";

jest.mock("../../src/debug", () => ({
	curryLog: () => () => {},
}));

const CREDENTIAL = {
	control_plane_url: "https://cp.knap.example",
	email: "me@example.test",
	password: "the-code-nobody-types",
};

const mockedRequestUrl = requestUrl as unknown as jest.Mock;

/**
 * A Knap that answers the claim, and an Obsidian that has nothing shared.
 *
 * The browser is replaced by a function that reads the challenge and state
 * out of the URL and calls the receiver back, which is exactly what the real
 * round trip does and lets a test assert on what was sent.
 */
function harness(overrides: Partial<Record<string, unknown>> = {}) {
	const created: unknown[] = [];
	const newFolders: unknown[] = [];
	const savedServers: unknown[] = [];
	let opened = "";

	const settings = {
		enabled: true,
		servers: [
			{
				id: "knap-sync",
				name: "Knap Sync",
				controlPlaneUrl: "https://cp.knap.example",
				isValidated: false,
			},
		],
		defaultServerId: "knap-sync",
	};

	const client = {
		listShares: jest.fn(async () => (overrides.remoteShares as unknown[]) ?? []),
		createShare: jest.fn(async (request: unknown) => {
			created.push(request);
			return { id: "share-1", path: "My Vault" };
		}),
	};

	const deps = {
		vault: { getName: () => "My Vault" },
		loginManager: {
			loginToServer: jest.fn(async () => (overrides.loginOk as boolean) ?? true),
			addServer: jest.fn(),
		},
		sharedFolders: {
			items: () => (overrides.localFolders as unknown[]) ?? [],
			new: jest.fn((...args: unknown[]) => {
				newFolders.push(args);
				return { settings: {} };
			}),
		},
		shareClients: { getClient: () => client },
		settings,
		saveServers: jest.fn(async (update: (c: unknown) => unknown) => {
			savedServers.push(update(settings));
		}),
		knapUrl: "https://knap.example",
		openBrowser: (url: string) => {
			opened = url;
			const params = new URL(url).searchParams;
			// The browser comes back. Async, because the real one always is.
			setTimeout(
				() =>
					handoffReceiver.handleCallback({
						token: "tok_from_knap",
						state: params.get("state") ?? "",
					}),
				0,
			);
		},
	} as unknown as SignInDeps;

	return {
		deps,
		client,
		created,
		newFolders,
		savedServers,
		openedUrl: () => opened,
	};
}

beforeEach(() => {
	handoffReceiver.cancel();
	mockedRequestUrl.mockReset();
	mockedRequestUrl.mockResolvedValue({ status: 200, json: CREDENTIAL });
});

describe("signing in is the whole of setup", () => {
	test("one press logs in and shares the vault", async () => {
		const h = harness();

		const result = await signIn(h.deps);

		expect(result.email).toBe("me@example.test");
		expect(result.sharedVault).toBe(true);
		// The three things a person used to do by hand, in order.
		expect(h.deps.loginManager.loginToServer).toHaveBeenCalledWith(
			"knap-sync",
			"me@example.test",
			"the-code-nobody-types",
		);
		expect(h.created).toEqual([
			{ kind: "folder", path: "My Vault", visibility: "private" },
		]);
		// Vault scope locally: no prefix, so every note in the vault is in.
		expect(h.newFolders[0]).toEqual(["", "share-1", "relay-onprem", false, "vault"]);
	});

	test("the browser is sent a challenge and never the verifier", async () => {
		const h = harness();
		await signIn(h.deps);

		const sent = new URL(h.openedUrl()).searchParams;
		expect(sent.get("challenge")).toMatch(/^[0-9a-f]{64}$/);
		expect(sent.get("state")).toBeTruthy();
		expect(h.openedUrl()).not.toContain("verifier");

		// The verifier goes straight to Knap over HTTPS instead, which is what
		// makes the token in the deep link worthless to whoever reads it.
		const claim = mockedRequestUrl.mock.calls[0][0] as {
			url: string;
			body: string;
		};
		expect(claim.url).toBe("https://knap.example/pair/plugin/claim");
		const body = JSON.parse(claim.body) as { token: string; verifier: string };
		expect(body.token).toBe("tok_from_knap");
		expect(body.verifier).toBeTruthy();
		expect(sent.get("challenge")).not.toBe(body.verifier);
	});

	test("nobody types a server URL, because Knap names it", async () => {
		const h = harness();
		await signIn(h.deps);
		// Already pointing there, so nothing was rewritten and nothing was
		// asked. The trailing-slash trap has no surface left to bite on.
		expect(h.savedServers).toEqual([]);
	});

	test("a control plane Knap names differently is followed, not reported", async () => {
		const h = harness();
		mockedRequestUrl.mockResolvedValue({
			status: 200,
			json: { ...CREDENTIAL, control_plane_url: "https://cp.other.example" },
		});

		await signIn(h.deps);

		expect(h.savedServers).toHaveLength(1);
		const saved = h.savedServers[0] as { servers: { controlPlaneUrl: string }[] };
		expect(saved.servers[0].controlPlaneUrl).toBe("https://cp.other.example");
		expect(h.deps.loginManager.addServer).toHaveBeenCalled();
	});

	test("a trailing slash from either side is normalised away", async () => {
		const h = harness();
		mockedRequestUrl.mockResolvedValue({
			status: 200,
			json: { ...CREDENTIAL, control_plane_url: "https://cp.knap.example/" },
		});

		await signIn(h.deps);

		// Measured on the real Add Server form: it appends /health without
		// normalising, so a trailing slash requested //health and answered 404
		// in a way that read as our outage. Nothing types it now, and nothing
		// stores it either.
		expect(h.savedServers).toEqual([]);
	});
});

describe("what it refuses to do", () => {
	test("a folder somebody already shared is left alone", async () => {
		// The narrower choice was deliberate. Widening it to the whole vault
		// behind their back is the one thing this flow must never do.
		const h = harness({ localFolders: [{ path: "Work" }] });

		const result = await signIn(h.deps);

		expect(result.sharedVault).toBe(false);
		expect(h.created).toEqual([]);
	});

	test("shares already on the account are left alone", async () => {
		const h = harness({ remoteShares: [{ id: "s-1", path: "Notes" }] });

		const result = await signIn(h.deps);

		expect(result.sharedVault).toBe(false);
		expect(h.created).toEqual([]);
	});

	test("a refused claim says why, in Knap's words", async () => {
		const h = harness();
		mockedRequestUrl.mockResolvedValue({
			status: 400,
			json: { error: "That sign-in link was already used or has expired." },
		});

		await expect(signIn(h.deps)).rejects.toThrow("already used or has expired");
		expect(h.deps.loginManager.loginToServer).not.toHaveBeenCalled();
	});

	test("a credential the relay will not take is not treated as success", async () => {
		const h = harness({ loginOk: false });

		await expect(signIn(h.deps)).rejects.toThrow("would not accept");
		expect(h.created).toEqual([]);
	});
});
