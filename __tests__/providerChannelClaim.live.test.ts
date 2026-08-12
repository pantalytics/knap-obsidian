/**
 * The plugin's own provider against a relay that routes channel events.
 *
 * Skipped unless SPIKE_CHANNEL_FEED points at the file the rig writes. That
 * rig lives in knap-mcp-admin at `scripts/spikes/relay_channel_feed/`: the
 * 0.9.7 relay image production runs, alone, with tokens minted there.
 *
 *   SPIKE_CHANNEL_FEED=../knap-mcp-admin/scripts/spikes/relay_channel_feed/spike-plugin.json \
 *     npx jest providerChannelClaim
 *
 * Why it exists. Knap is about to set the `channel` claim on the relay
 * tokens its control plane issues, so its own replica can hear note edits
 * over the folder-document socket it already holds. Those are the same
 * tokens this plugin gets. This provider has handlers for message types 0
 * to 3 and nothing at 4, so the question is whether a relay that has learned
 * to send type 4 can still be talked to by a client that has not.
 *
 * Two halves, and the second is the one that cannot be reasoned about:
 * the rig measures that the relay sends events only to connections that
 * subscribed (this provider never does), and this measures what happens if
 * one arrives anyway. The frame injected below is not a plausible frame, it
 * is the exact bytes the relay emitted, captured by the rig.
 */

import { describe, test, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { readFileSync } from "fs";
import * as Y from "yjs";
import { YSweetProvider } from "../src/client/provider";

const RIG = process.env.SPIKE_CHANNEL_FEED ?? "";

// Same reason as provider.test.ts: jest.setup.js aliases activeWindow to a
// plain Node object, which has no EventTarget methods.
const globalStub = globalThis as unknown as {
	addEventListener?: () => void;
	removeEventListener?: () => void;
};
globalStub.addEventListener ??= () => {};
globalStub.removeEventListener ??= () => {};

type Rig = {
	relay: string;
	doc: string;
	channel: string;
	token: string;
	frame_hex: string;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 10000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return predicate();
};

const live = RIG ? describe : describe.skip;

live("YSweetProvider against a relay with the channel claim on", () => {
	let rig: Rig;
	let doc: Y.Doc;
	let provider: YSweetProvider;

	beforeAll(async () => {
		rig = JSON.parse(readFileSync(RIG, "utf8")) as Rig;
		doc = new Y.Doc();
		provider = new YSweetProvider(`${rig.relay}/doc/ws`, rig.doc, doc, {
			params: { token: rig.token },
			// One process, no other tab: the broadcast channel would only add
			// a second path for the same bytes and a handle to clean up.
			disableBc: true,
		});
		await waitFor(() => provider.synced);
	}, 30000);

	afterAll(() => {
		provider?.destroy();
	});

	test("a token carrying a channel claim still syncs a document", () => {
		expect(provider.synced).toBe(true);
		expect(provider.connectionState.status).toBe("connected");
	});

	test("an unsolicited MSG_EVENT frame is dropped and nothing else moves", async () => {
		const before = doc.getText("content").toString();
		const errors: unknown[][] = [];
		const spy = jest
			.spyOn(console, "error")
			.mockImplementation((...args: unknown[]) => {
				errors.push(args);
			});

		try {
			// The relay's own bytes, captured by the rig: varuint(4) then the
			// CBOR event. Pushed in through the socket's own handler, which is
			// the path a frame from the wire takes.
			const frame = Uint8Array.from(Buffer.from(rig.frame_hex, "hex"));
			const socket = provider.ws as WebSocket & {
				onmessage: (event: { data: ArrayBuffer }) => void;
			};
			expect(socket).toBeTruthy();
			expect(() =>
				socket.onmessage({
					data: frame.buffer.slice(
						frame.byteOffset,
						frame.byteOffset + frame.byteLength,
					) as ArrayBuffer,
				}),
			).not.toThrow();

			// It reaches the "no handler" branch, and that branch is a log
			// line. Worth recording rather than assuming: if a relay ever
			// pushed these unsolicited, this is one console line per note
			// edit on somebody's phone.
			expect(errors.flat()).toContain("Unable to compute message");
		} finally {
			spy.mockRestore();
		}

		expect(provider.synced).toBe(true);
		expect(provider.connectionState.status).toBe("connected");
		expect(doc.getText("content").toString()).toBe(before);

		// And the socket still carries real work afterwards: a local edit
		// reaches the relay and comes back to a second provider on the same
		// document.
		const stamp = `na-het-event-${Date.now()}`;
		doc.getText("content").insert(0, stamp);

		const echoDoc = new Y.Doc();
		const echo = new YSweetProvider(`${rig.relay}/doc/ws`, rig.doc, echoDoc, {
			params: { token: rig.token },
			disableBc: true,
		});
		try {
			await waitFor(() => echoDoc.getText("content").toString().includes(stamp));
			expect(echoDoc.getText("content").toString()).toContain(stamp);
		} finally {
			echo.destroy();
		}
	}, 30000);
});
