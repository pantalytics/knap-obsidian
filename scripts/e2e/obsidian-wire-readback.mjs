/*
 * The host half of the Obsidian wire end to end.
 *
 * Joins the same relay document from outside Obsidian, using this fork's own
 * provider, and checks both directions: what the plugin wrote arrives here,
 * and what is written here arrives in the plugin.
 *
 * Run by run-obsidian-wire.sh, which passes the in-app result as argv[3].
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import * as Y from "yjs";

if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
if (typeof globalThis.activeWindow === "undefined") {
	globalThis.activeWindow = { addEventListener() {}, removeEventListener() {} };
}

const [, , relayBase, docId, inAppRaw] = process.argv;
// The harness prints whatever the expression returned. Depending on how it
// serialises, that arrives here as JSON or as JSON wrapped in a JSON string.
const parseMaybeTwice = (raw) => {
	let value = JSON.parse(raw ?? "{}");
	if (typeof value === "string") value = JSON.parse(value);
	return value;
};
const inApp = parseMaybeTwice(inAppRaw);
const harness =
	process.env.KNAP_OBSIDIAN_HARNESS ??
	join(process.cwd(), "..", "knap-mcp-admin", "scripts", "dev", "obsidian", "obsidian.sh");

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
	disableBc: true,
	WebSocketPolyfill: WebSocket,
});
await wait(5000);

const fromObsidian = doc.getText("contents").toString();

const addition = " -- en dit kwam van buiten Obsidian";
const text = doc.getText("contents");
text.insert(text.length, addition);
await wait(4000);

const seenInObsidian = String(
	execFileSync(harness, ["eval", "window.__knapWireDoc.ytext.toString()"], {
		encoding: "utf8",
	}),
)
	.trim()
	.split("\n")
	.pop();

try {
	provider.destroy();
} catch (e) {
	/* closing is best effort */
}

const result = {
	folderSynced: inApp.folderSynced,
	docConnected: inApp.docConnected,
	obsidianToHost: fromObsidian,
	hostToObsidian: seenInObsidian,
};
console.log(JSON.stringify(result));

const failures = [];
if (!inApp.docConnected) {
	failures.push("the plugin's document never held an open socket");
}
if (!String(inApp.docUrl || "").startsWith("wss://")) {
	failures.push(`the plugin did not connect over wss, url was ${inApp.docUrl}`);
}
if (fromObsidian !== inApp.wrote) {
	failures.push(
		`what the plugin wrote did not arrive here: ${JSON.stringify(fromObsidian)}`,
	);
}
if (!seenInObsidian.includes(addition.trim())) {
	failures.push(
		`what was written here did not arrive in the plugin: ${JSON.stringify(seenInObsidian)}`,
	);
}

if (failures.length) {
	console.error("\nFAIL");
	for (const f of failures) console.error("  " + f);
	process.exit(1);
}
console.log(
	"\nOK: Obsidian and a second participant round trip through a real relay, both directions",
);
process.exit(0);
