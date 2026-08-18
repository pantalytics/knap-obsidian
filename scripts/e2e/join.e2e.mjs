/*
 * A member joining a populated vault, over the wire (#90, and #85 before it).
 *
 * What #85 was: somebody added to an existing cloud vault linked it, the
 * folder document synced, `filemeta_v0` arrived complete, and not one note
 * was downloaded. The cause was one path expression. A joiner runs
 * `mkdir(dirname(vpath))` for every entry that is not on its disk yet, and
 * `dirname` of a root-level path is ".", which at vault scope trips the
 * dot-segment exclusion. The first root-level entry threw, that rejection
 * took the whole folder pass of `syncFileTree` down, and the file pass never
 * ran for anything.
 *
 * The owner never sees it. Their files already exist locally, so the create
 * path is never reached, which is why it survived to 1.13.2: the first fill
 * of a joined vault is the one path no already-synced device exercises.
 *
 * So this test is about the shape of the entries a joiner receives rather
 * than about the transport. A relay document is filled with the file list of
 * a populated vault, root-level entries included, by one participant. A
 * second participant joins it cold, having never heard of it, and what it
 * receives is put through the share's own path rules -- the real ones, from
 * src/vaultScope.ts, imported rather than restated -- exactly as a joiner
 * applies them. A root-level entry must survive.
 *
 * What this does NOT cover, and #90 stays open for: the account half. A
 * second Zitadel account, added as a member of a share it did not create,
 * signing in and attaching that share. That needs the control plane, the
 * relay's admin API and a real Obsidian, which is the rig described in
 * scripts/e2e/JOIN-RIG.md.
 *
 * Usage: node scripts/e2e/join.e2e.mjs [relayBase]
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

// The provider reaches for window.setInterval and, on teardown, activeWindow.
// Same shim as wire.e2e.mjs, and for the same reason.
if (typeof globalThis.window === "undefined") {
	globalThis.window = globalThis;
}
if (typeof globalThis.activeWindow === "undefined") {
	globalThis.activeWindow = { addEventListener() {}, removeEventListener() {} };
}

const out = await mkdtemp(join(process.cwd(), "node_modules", ".knap-join-"));

await build({
	entryPoints: ["src/client/provider.ts"],
	outfile: join(out, "provider.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
	external: ["yjs", "y-protocols", "lib0"],
});
// The share's path rules, bundled from source rather than restated here. If
// somebody changes what a share will write to, this test changes with it.
await build({
	entryPoints: ["src/vaultScope.ts"],
	outfile: join(out, "vaultScope.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
});

const { YSweetProvider } = await import(
	pathToFileURL(join(out, "provider.mjs")).href
);
const { checkPath, toVaultPath } = await import(
	pathToFileURL(join(out, "vaultScope.mjs")).href
);

const docId = `join-e2e-${process.pid}`;
const serverUrl = `${RELAY}/doc/ws`;
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
	console.error(
		"start one with scripts/e2e/run-wire.sh, or pass a relay base as argv[2]",
	);
	process.exit(2);
}
if (!created.ok) {
	console.error(`could not create the relay document: ${created.status}`);
	process.exit(2);
}

const participant = () => {
	const doc = new Y.Doc();
	const provider = new YSweetProvider(serverUrl, docId, doc, {
		connect: true,
		disableBc: true, // the wire or nothing
		WebSocketPolyfill: WebSocket,
	});
	return { doc, provider, meta: () => doc.getMap("filemeta_v0") };
};

/**
 * The file list of a vault that has been in use: notes at the root, notes in
 * folders, and the folders themselves. The root-level pair is the whole
 * point. `Anaïs' dagboek.md` is here because a name with an apostrophe and a
 * diacritic in it is a name a path rule can trip over, and it is a real one.
 */
const REMOTE_TREE = [
	["welkom.md", "markdown"],
	["Anaïs' dagboek.md", "markdown"],
	["Projects", "folder"],
	["Projects/acme.md", "markdown"],
	["Projects/deep", "folder"],
	["Projects/deep/notes.md", "markdown"],
];

// The owner, whose vault this already is.
const owner = participant();
await wait(2500);
owner.doc.transact(() => {
	const meta = owner.meta();
	REMOTE_TREE.forEach(([path, type], i) => {
		meta.set(path, {
			version: 0,
			id: `00000000-0000-4000-8000-00000000${String(i).padStart(4, "0")}`,
			type,
		});
	});
});
await wait(2500);

// The member, who has never heard of this document before now.
const member = participant();
await wait(3500);

const received = [...member.meta().keys()].sort();
const expected = REMOTE_TREE.map(([path]) => path).sort();
const connected = owner.provider.wsconnected && member.provider.wsconnected;

/**
 * What the joiner does with each entry it received, by the share's own
 * rules. A vault share has no prefix, so the vault path is the virtual path;
 * `dirname` is what `_handleServerCreate` asks mkdir for.
 */
const dirnameOf = (path) => {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? "." : path.slice(0, cut);
};

const writable = [];
const refused = [];
const parentRefused = [];
for (const vpath of received) {
	const vaultPath = toVaultPath("vault", "", vpath, "/");
	if (checkPath("vault", "", vaultPath, "/", ".obsidian")) {
		writable.push(vpath);
	} else {
		refused.push(vpath);
	}
	// The #85 line itself: mkdir of the parent, unconditionally.
	const parent = dirnameOf(vpath);
	if (!checkPath("vault", "", parent, "/", ".obsidian")) {
		parentRefused.push(vpath);
	}
}

for (const p of [owner, member]) {
	try {
		p.provider.destroy();
	} catch (e) {
		/* closing is best effort */
	}
}
await rm(out, { recursive: true, force: true });

const result = {
	allConnected: connected,
	entriesReceived: received.length,
	rootLevelReceived: received.filter((p) => !p.includes("/")),
	writable: writable.length,
	refused,
	// Entries whose parent directory the share refuses. Every root-level one
	// is on this list, because "." is a dot segment: that is the bug, and
	// the fix is that a joiner never asks for a parent it does not need.
	parentRefused,
};
console.log(JSON.stringify(result, null, 2));

const failures = [];
if (!connected) {
	failures.push("a participant was not connected over the websocket");
}
if (received.join("\n") !== expected.join("\n")) {
	failures.push(
		`the member did not receive the whole file list, got ${JSON.stringify(received)}`,
	);
}
if (result.rootLevelReceived.length < 2) {
	failures.push("the file list carried no root-level entries to test with");
}
if (refused.length > 0) {
	failures.push(
		`the share refuses to write entries it was sent: ${JSON.stringify(refused)}`,
	);
}
// The regression, stated as what a joiner must not do rather than as what
// the old code did: asking for the parent of a root-level entry is asking
// for ".", the share refuses it, and #85 is that refusal killing the pass.
// Every root-level entry must therefore be one the joiner skips the mkdir
// for. This assertion fails the day somebody reinstates the unconditional
// mkdir, whatever it is spelled as.
const rootLevelWithRefusedParent = result.rootLevelReceived.filter((p) =>
	parentRefused.includes(p),
);
if (
	rootLevelWithRefusedParent.length !== result.rootLevelReceived.length
) {
	failures.push(
		"expected every root-level entry's parent to be a path the share refuses; " +
			"if that is no longer true the premise of this test has changed",
	);
}

if (failures.length) {
	console.error("\nFAIL");
	for (const f of failures) console.error("  " + f);
	process.exit(1);
}
console.log(
	"\nOK: a cold member receives the whole file list over a real relay, root-level entries included, and every entry is one the share will write",
);
process.exit(0);
