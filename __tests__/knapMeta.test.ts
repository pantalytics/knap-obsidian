import * as Y from "yjs";
import { KNAP_META_KEY, readKnapMeta, stampKnapMeta } from "../src/knapMeta";

describe("what a share says about itself", () => {
	test("a vault share says so, and says what the vault is called", () => {
		const doc = new Y.Doc();
		expect(stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" })).toBe(true);

		expect(readKnapMeta(doc)).toEqual({ scope: "vault", vault: "Pantalytics" });
	});

	test("a folder share says that instead", () => {
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "folder", vault: "Pantalytics" });

		expect(readKnapMeta(doc)?.scope).toBe("folder");
	});

	test("it lives in a map of its own and leaves the file lists alone", () => {
		// The document is upstream's and carries the folder's contents. Ours is
		// one key beside them, which is what makes it safe to write into a
		// structure we did not design.
		const doc = new Y.Doc();
		doc.getMap<string>("docs").set("Note.md", "doc-1");
		stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" });

		expect(doc.getMap<string>("docs").get("Note.md")).toBe("doc-1");
		expect(doc.getMap("filemeta_v0").size).toBe(0);
		expect(doc.getMap(KNAP_META_KEY).size).toBe(2);
	});

	test("writing the same thing twice is not a write", () => {
		// It runs on every connect rather than once at creation, because a share
		// made by an older build carries no key at all. Without this every
		// device would broadcast an update on every start.
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" });

		let updates = 0;
		doc.on("update", () => {
			updates += 1;
		});
		expect(stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" })).toBe(false);
		expect(updates).toBe(0);
	});

	test("a vault keeps the name it was given, whoever connects next", () => {
		// A vault is picked from a list now, so one vault on Knap can be open
		// in local vaults called different things. Writing the local name
		// through would hand the vault's name on Knap to whoever opened
		// Obsidian last.
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" });

		expect(stampKnapMeta(doc, { scope: "vault", vault: "Laptop copy" })).toBe(false);
		expect(readKnapMeta(doc)?.vault).toBe("Pantalytics");
	});

	test("a share that carries no name yet gets one", () => {
		// Every vault made before this key existed, and every vault the moment
		// after it is created. The first device to sync it names it.
		const doc = new Y.Doc();
		doc.getMap<string>(KNAP_META_KEY).set("scope", "vault");

		expect(stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" })).toBe(true);
		expect(readKnapMeta(doc)?.vault).toBe("Pantalytics");
	});

	test("the scope is corrected even though the name is not", () => {
		// The scope is not a name: both sides compute it the same way, and a
		// share whose shape changed under an older build carries a stale one.
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "folder", vault: "Pantalytics" });

		expect(stampKnapMeta(doc, { scope: "vault", vault: "Anything else" })).toBe(true);
		expect(readKnapMeta(doc)).toEqual({ scope: "vault", vault: "Pantalytics" });
	});

	test("surrounding whitespace never reaches the panel", () => {
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "vault", vault: "  Pantalytics  " });

		expect(readKnapMeta(doc)?.vault).toBe("Pantalytics");
	});

	test("a document nobody stamped answers nothing rather than guessing", () => {
		expect(readKnapMeta(new Y.Doc())).toBeNull();
	});
});
