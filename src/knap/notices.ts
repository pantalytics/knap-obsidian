/**
 * What the server says down the socket when something went wrong there
 * (ADR-0095).
 *
 * Until this existed the only sentence the server could say to a device was a
 * close code, so everything short of "go away" was a warning in a log on a
 * box and a silence in Obsidian. The case that made it worth building: a note
 * whose name the server's search copy will not hold goes on syncing between
 * somebody's machines exactly as it should, while every AI answers that the
 * note does not exist, and nothing anywhere says so.
 *
 * One frame, one direction. The server sends message type 42 with a JSON
 * varstring behind it; nothing here ever writes one. It arrives on the tree
 * socket, which is the socket a linked vault always holds, so a notice comes
 * in once rather than once per open note.
 *
 * A notice is a sentence for a person and not an error to switch on: `code`
 * is the stable half and `text` is the English, which the server may reword
 * any day without breaking this.
 */

import * as decoding from "lib0/decoding";
import type { WebsocketProvider } from "y-websocket";

/**
 * Our type in the y-protocol stream. y-websocket dispatches on the leading
 * varuint and reserves 0 (sync), 1 (awareness), 2 (auth) and 3 (query
 * awareness). The same number is spelled in `knap_server/sockets.py`, and
 * `tests/test_knap_server_faults.py` there asserts the bytes.
 */
export const NOTICE_MESSAGE = 42;

/** How loudly to say it. Anything else is read as "warn". */
export type NoticeLevel = "info" | "warn" | "error";

/** One thing the server has to tell this device. */
export interface ServerNotice {
	level: NoticeLevel;
	code: string;
	text: string;
}

const LEVELS: readonly string[] = ["info", "warn", "error"];

/**
 * One notice off the wire, or null if what arrived was not one.
 *
 * Everything is checked because everything is somebody else's bytes, and a
 * malformed frame must be a notice that does not arrive rather than a socket
 * that falls over. A newer server sending a shape this build does not know is
 * the normal state of the world, not an error.
 */
export function readNotice(payload: string): ServerNotice | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { level, code, text } = parsed as Record<string, unknown>;
	if (typeof code !== "string" || typeof text !== "string" || !text) return null;
	return {
		level: typeof level === "string" && LEVELS.includes(level) ? (level as NoticeLevel) : "warn",
		code,
		text,
	};
}

/**
 * Listen for notices on one provider's socket.
 *
 * y-websocket copies its handler table per instance and dispatches on the
 * leading varuint, so this is a slot in a table rather than a patch: an
 * unknown type without it logs "Unable to compute message" to the console and
 * carries on, which is what an older build of this plugin does and is the
 * right behaviour for it.
 *
 * The handler writes nothing back. y-websocket replies only when a handler
 * put something in the encoder, and a notice is not a question.
 */
export function listenForNotices(
	provider: WebsocketProvider,
	onNotice: (notice: ServerNotice) => void,
): void {
	provider.messageHandlers[NOTICE_MESSAGE] = (_encoder, decoder) => {
		let notice: ServerNotice | null = null;
		try {
			notice = readNotice(decoding.readVarString(decoder));
		} catch {
			// A frame we cannot read is a frame we drop. The socket carries
			// notes, and it is not going down over a diagnostic message.
			return;
		}
		if (notice) onNotice(notice);
	};
}
