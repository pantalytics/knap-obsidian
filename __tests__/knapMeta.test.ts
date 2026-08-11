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
		// made by an older build carries no key and a renamed vault carries a
		// stale one. Without this every device would broadcast an update on
		// every start.
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" });

		let updates = 0;
		doc.on("update", () => {
			updates += 1;
		});
		expect(stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" })).toBe(false);
		expect(updates).toBe(0);
	});

	test("a renamed vault is written through", () => {
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "vault", vault: "Old name" });

		expect(stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" })).toBe(true);
		expect(readKnapMeta(doc)?.vault).toBe("Pantalytics");
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
