/**
 * The HTTP half of the new client, against a hand-rolled fetch.
 *
 * The real server's answers are pinned by knap-mcp-admin's own suite; what
 * these tests hold still is what the plugin sends and how it reads answers,
 * so a drifting field name fails here rather than on somebody's laptop.
 */

import { KnapServer, KnapServerError } from "../../src/knap/KnapServer";

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
	const calls: Call[] = [];
	const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		const key = Object.keys(routes).find((route) => url.includes(route));
		if (!key) return new Response("not found", { status: 404 });
		return routes[key](init);
	};
	return { fetchFn, calls };
}

describe("KnapServer", () => {
	it("exchanges a handoff code for a token, and refuses a reused one", async () => {
		const { fetchFn, calls } = fakeFetch({
			"/auth/plugin/exchange": (init) => {
				const body = JSON.parse(String(init?.body));
				return body.code === "eenmalig"
					? new Response(JSON.stringify({ token: "knap_abc" }), { status: 200 })
					: new Response("{}", { status: 400 });
			},
		});
		const server = new KnapServer("https://knap.test", fetchFn);

		expect(await server.exchange("eenmalig", "Laptop")).toBe("knap_abc");
		expect(JSON.parse(String(calls[0].init?.body)).device).toBe("Laptop");

		await expect(server.exchange("eenmalig-maar-op", "Laptop")).rejects.toThrow(
			/already used or has expired/,
		);
	});

	it("lists vaults in the plugin's shape", async () => {
		const { fetchFn, calls } = fakeFetch({
			"/api/vaults": () =>
				new Response(
					JSON.stringify({
						vaults: [{ id: "v1", name: "Demo" }],
					}),
					{ status: 200 },
				),
		});
		const server = new KnapServer("https://knap.test/", fetchFn);

		const vaults = await server.listVaults("knap_abc");
		expect(vaults).toEqual([{ id: "v1", name: "Demo" }]);
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer knap_abc",
		);
	});

	it("says sign in again on a dead token", async () => {
		const { fetchFn } = fakeFetch({
			"/api/vaults": () => new Response("{}", { status: 401 }),
		});
		const server = new KnapServer("https://knap.test", fetchFn);
		await expect(server.listVaults("knap_oud")).rejects.toThrow(/Sign in again/);
	});

	it("builds the socket and file addresses the server serves", () => {
		const server = new KnapServer("https://knap.example", async () => new Response(""));
		expect(server.syncUrl("v1")).toBe("wss://knap.example/sync/v1");
		expect(server.signInUrl()).toBe("https://knap.example/auth/plugin/start");
	});

	it("round-trips an attachment and verifies nothing itself", async () => {
		const bytes = new TextEncoder().encode("pdf!").buffer;
		const { fetchFn, calls } = fakeFetch({
			"/files/v1/Bijlagen/scan%20maandag.pdf": (init) =>
				init?.method === "PUT"
					? new Response(JSON.stringify({ sha256: "abc", size: 4 }), { status: 200 })
					: new Response(new Uint8Array(bytes)),
		});
		const server = new KnapServer("https://knap.test", fetchFn);

		const answer = await server.uploadFile("t", "v1", "Bijlagen/scan maandag.pdf", bytes);
		expect(answer.sha256).toBe("abc");
		// Path segments travel encoded, slashes stay structural.
		expect(calls[0].url).toContain("/files/v1/Bijlagen/scan%20maandag.pdf");

		const back = await server.downloadFile("t", "v1", "Bijlagen/scan maandag.pdf");
		expect(new TextDecoder().decode(back)).toBe("pdf!");
	});

	it("wraps failures in one error type with the status attached", async () => {
		const { fetchFn } = fakeFetch({});
		const server = new KnapServer("https://knap.test", fetchFn);
		try {
			await server.downloadFile("t", "v1", "weg.png");
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(KnapServerError);
			expect((error as KnapServerError).status).toBe(404);
		}
	});
});
