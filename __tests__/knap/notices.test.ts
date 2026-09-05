/**
 * The frame the server sends when something went wrong on its side
 * (ADR-0095), read here the way the plugin reads it.
 *
 * The bytes in `FROM_THE_SERVER` were produced by the server's own encoder
 * (`knap_server/sockets.py`, `encode_notice`) and pasted in. That is the
 * point of them: a format written down in two repositories that ship
 * separately is the one thing neither repository's own tests can see going
 * wrong, so this side asserts against the other side's actual output rather
 * than against its own idea of it.
 */

import * as decoding from "lib0/decoding";

import { NOTICE_MESSAGE, listenForNotices, readNotice } from "../../src/knap/notices";
import type { ServerNotice } from "../../src/knap/notices";

/**
 * One real notice off knap_server: a warn about a name the search copy will
 * not hold. 182 bytes, and its length needs two varint bytes, which is the
 * case a one-byte reader gets wrong on every notice that matters.
 */
const FROM_THE_SERVER = new Uint8Array([
	42, 179, 1, 123, 34, 108, 101, 118, 101, 108, 34, 58, 34, 119, 97, 114, 110, 34, 44, 34,
	99, 111, 100, 101, 34, 58, 34, 110, 111, 116, 101, 45, 110, 111, 116, 45, 105, 110, 45,
	115, 101, 97, 114, 99, 104, 45, 99, 111, 112, 121, 34, 44, 34, 116, 101, 120, 116, 34, 58,
	34, 66, 111, 111, 100, 115, 99, 104, 97, 112, 112, 101, 110, 46, 116, 120, 116, 32, 115,
	121, 110, 99, 115, 32, 98, 101, 116, 119, 101, 101, 110, 32, 121, 111, 117, 114, 32, 100,
	101, 118, 105, 99, 101, 115, 44, 32, 98, 117, 116, 32, 105, 116, 115, 32, 110, 97, 109,
	101, 32, 105, 115, 32, 111, 110, 101, 32, 116, 104, 101, 32, 115, 101, 97, 114, 99, 104,
	32, 99, 111, 112, 121, 32, 119, 105, 108, 108, 32, 110, 111, 116, 32, 104, 111, 108, 100,
	44, 32, 115, 111, 32, 97, 110, 32, 65, 73, 32, 99, 97, 110, 110, 111, 116, 32, 102, 105,
	110, 100, 32, 105, 116, 46, 34, 125,
]);

/** Enough of a y-websocket provider for the handler table. */
function fakeProvider() {
	return { messageHandlers: [] as unknown[] } as never;
}

/** Feed one whole frame to whatever the provider registered for it. */
function deliver(provider: { messageHandlers: unknown[] }, frame: Uint8Array): void {
	const decoder = decoding.createDecoder(frame);
	const type = decoding.readVarUint(decoder);
	const handler = provider.messageHandlers[type] as
		| ((...args: unknown[]) => void)
		| undefined;
	handler?.(null, decoder, provider, false, type);
}

describe("server notices", () => {
	it("reads a frame the server actually produced", () => {
		const provider = fakeProvider() as unknown as { messageHandlers: unknown[] };
		const heard: ServerNotice[] = [];
		listenForNotices(provider as never, (notice) => heard.push(notice));

		expect(FROM_THE_SERVER[0]).toBe(NOTICE_MESSAGE);
		deliver(provider, FROM_THE_SERVER);

		expect(heard).toHaveLength(1);
		expect(heard[0].level).toBe("warn");
		expect(heard[0].code).toBe("note-not-in-search-copy");
		expect(heard[0].text).toContain("Boodschappen.txt");
	});

	it("takes an unknown level as a warning rather than dropping the notice", () => {
		expect(readNotice('{"level":"catastrophe","code":"x","text":"Something."}')).toEqual({
			level: "warn",
			code: "x",
			text: "Something.",
		});
	});

	it("refuses anything that is not a notice", () => {
		expect(readNotice("not json")).toBeNull();
		expect(readNotice("[]")).toBeNull();
		expect(readNotice("null")).toBeNull();
		expect(readNotice('{"code":"x"}')).toBeNull();
		expect(readNotice('{"code":"x","text":""}')).toBeNull();
		expect(readNotice('{"code":7,"text":"Something."}')).toBeNull();
	});

	it("a frame it cannot read does not reach the caller and does not throw", () => {
		const provider = fakeProvider() as unknown as { messageHandlers: unknown[] };
		const heard: ServerNotice[] = [];
		listenForNotices(provider as never, (notice) => heard.push(notice));

		// The type byte, and then nothing behind it.
		expect(() => deliver(provider, new Uint8Array([NOTICE_MESSAGE]))).not.toThrow();
		expect(heard).toEqual([]);
	});

	it("claims only its own message type", () => {
		const provider = fakeProvider() as unknown as { messageHandlers: unknown[] };
		listenForNotices(provider as never, () => undefined);
		const claimed = provider.messageHandlers
			.map((handler, type) => (handler ? type : -1))
			.filter((type) => type >= 0);
		expect(claimed).toEqual([NOTICE_MESSAGE]);
	});
});
