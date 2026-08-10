/*
 * The other device, in the Obsidian wire end to end.
 *
 * Joins the same relay document from outside Obsidian using this fork's own
 * provider. Called twice by run-obsidian-wire.sh: once to read what the
 * plugin pushed off the disk, once to write a line back.
 *
 *   node obsidian-wire-readback.mjs <relayBase> <docId> read
 *   node obsidian-wire-readback.mjs <relayBase> <docId> write "<line>"
 */
import { build } from "esbuild";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import * as Y from "yjs";

if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
if (typeof globalThis.activeWindow === "undefined") {
	globalThis.activeWindow = { addEventListener() {}, removeEventListener() {} };
}

const [, , relayBase, docId, mode, line] = process.argv;

const outfile = join(process.cwd(), "node_modules", ".obsidian-wire-provider.mjs");
await build({
	entryPoints: ["src/client/provider.ts"],
	outfile,
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
	external: ["yjs", "y-protocols", "lib0"],
});
const { YSweetProvider } = await import(pathToFileURL(outfile).href);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = new Y.Doc();
const provider = new YSweetProvider(`${relayBase}/doc/ws`, docId, doc, {
	connect: true,
	disableBc: true, // the wire or nothing
	WebSocketPolyfill: WebSocket,
});
await wait(5000);

const text = doc.getText("contents");
if (mode === "write") {
	text.insert(text.length, line);
	await wait(4000);
}

const result = { connected: provider.wsconnected, text: text.toString() };
try {
	provider.destroy();
} catch (e) {
	/* closing is best effort */
}
console.log(JSON.stringify(result));
process.exit(result.connected ? 0 : 1);
