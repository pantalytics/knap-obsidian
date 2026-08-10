/*
 * End to end over the wire, using this fork's own transport.
 *
 * Two independent participants, each with its own Y.Doc and its own
 * YSweetProvider -- the same class the plugin connects with, bundled straight
 * out of src/client/provider.ts rather than reimplemented -- against a real
 * y-sweet relay. Text goes up from one and comes back down at the other, both
 * ways, and the only channel between them is the websocket.
 *
 * What this does not cover: Obsidian. The renderer runs on an app:// origin
 * that Chromium treats as a secure context, and it refuses a plaintext ws://
 * even to localhost, so the app cannot reach a local relay without TLS the
 * container would have to trust. The Obsidian half is covered by
 * scope.e2e.js, which is the file-and-share half; this is the transport half.
 *
 * Usage: node scripts/e2e/wire.e2e.mjs [relayBase]
 *   relayBase defaults to ws://127.0.0.1:8099, a y-sweet started by run-wire.sh
 */
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import * as Y from "yjs";

const RELAY = process.argv[2] || "ws://127.0.0.1:8099";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The provider reaches for `window.setInterval` unconditionally, and for
// `activeWindow` on teardown. Harmless in the plugin, which only ever runs in
// a renderer, but it means the transport cannot be exercised outside a browser
// without this. Worth knowing before anyone reuses provider.ts server-side.
if (typeof globalThis.window === "undefined") {
	globalThis.window = globalThis;
}
if (typeof globalThis.activeWindow === "undefined") {
	globalThis.activeWindow = { addEventListener() {}, removeEventListener() {} };
}

// Inside the repo, so the externals below resolve from its node_modules.
const out = await mkdtemp(join(process.cwd(), "node_modules", ".knap-wire-"));
const bundle = join(out, "provider.mjs");

await build({
	entryPoints: ["src/client/provider.ts"],
	outfile: bundle,
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
	// Shared, not bundled. Two copies of Yjs in one process break its
	// constructor checks, and the two participants would not agree on types.
	external: ["yjs", "y-protocols", "lib0"],
});

const { YSweetProvider } = await import(pathToFileURL(bundle).href);

// One relay document, two participants that share nothing but the wire.
const docId = `wire-e2e-${process.pid}`;
// This y-sweet serves the socket at /doc/ws/<docId>, and the provider
// builds its url as serverUrl + "/" + roomname, so the split falls here.
const serverUrl = `${RELAY}/doc/ws`;

// y-sweet 404s the websocket route for a document it has never heard of, so
// the document is created first. In the real stack the control plane does
// this when a share is made.
const httpBase = RELAY.replace(/^ws/, "http");
let created;
try {
	created = await fetch(`${httpBase}/doc/new`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ docId }),
	});
} catch (e) {
	console.error(`no relay at ${RELAY}: ${e.cause?.code || e.message}`);
	console.error("start one with scripts/e2e/run-wire.sh, or pass a relay base as argv[2]");
	process.exit(2);
}
if (!created.ok) {
	console.error(`could not create the relay document: ${created.status}`);
	process.exit(2);
}

const participant = (name) => {
	const doc = new Y.Doc();
	const provider = new YSweetProvider(serverUrl, docId, doc, {
		connect: true,
		disableBc: true, // no BroadcastChannel shortcut: the wire or nothing
		WebSocketPolyfill: WebSocket,
	});
	return { name, doc, provider, text: () => doc.getText("contents").toString() };
};

const a = participant("A");
const b = participant("B");
await wait(3000);

a.doc.getText("contents").insert(0, "een notitie vanaf A");
await wait(3000);
const bSaw = b.text();

b.doc.getText("contents").insert(bSaw.length, ", aangevuld door B");
await wait(3000);
const aSaw = a.text();

// A third participant, joining cold, must receive the whole history.
const c = participant("C");
await wait(3500);
const cSaw = c.text();

const connected = [a, b, c].every((p) => p.provider.wsconnected);
for (const p of [a, b, c]) {
	try {
		p.provider.destroy();
	} catch (e) {
		/* closing is best effort */
	}
}
await rm(out, { recursive: true, force: true });

const result = {
	// Proof the wire carried it, not a same-process shortcut: an earlier
	// version of this test synced two participants over BroadcastChannel and
	// read as a pass. disableBc is set above; this is the belt.
	allConnected: connected,
	bReceivedFromA: bSaw,
	aReceivedFromB: aSaw,
	cJoinedCold: cSaw,
};
console.log(JSON.stringify(result));

const failures = [];
if (!result.allConnected) {
	failures.push("a participant was not connected over the websocket");
}
if (bSaw !== "een notitie vanaf A") {
	failures.push(`B did not receive A's insert, got ${JSON.stringify(bSaw)}`);
}
if (aSaw !== "een notitie vanaf A, aangevuld door B") {
	failures.push(`A did not receive B's insert, got ${JSON.stringify(aSaw)}`);
}
if (cSaw !== aSaw) {
	failures.push(`a cold participant did not catch up, got ${JSON.stringify(cSaw)}`);
}

if (failures.length) {
	console.error("\nFAIL");
	for (const f of failures) console.error("  " + f);
	process.exit(1);
}
console.log("\nOK: the fork's own provider round trips over a real relay, both ways, and a cold join catches up");
process.exit(0);
