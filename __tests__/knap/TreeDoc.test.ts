/**
 * The tree document: real Yjs, no network, and the property that matters
 * proven the CRDT way -- two docs that each changed the tree converge on
 * the same map after exchanging updates.
 */

import * as Y from "yjs";

import { TreeDoc, normalize } from "../../src/knap/TreeDoc";

describe("TreeDoc", () => {
	it("mints an id once and keeps it across a move", () => {
		const tree = new TreeDoc(new Y.Doc());
		const id = tree.ensureNote("Notes/plan.md");
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(tree.ensureNote("Notes/plan.md")).toBe(id);
		expect(tree.ensureNote("./Notes//plan.md")).toBe(id); // one spelling per path

		const moved = tree.move("Notes/plan.md", "Archief/plan.md");
		expect(moved).toBe(id);
		expect(tree.docIdFor("Notes/plan.md")).toBeUndefined();
		expect(tree.docIdFor("Archief/plan.md")).toBe(id);
		expect(tree.pathFor(id)).toBe("Archief/plan.md");
	});

	it("removal is leaving the tree, and only that", () => {
		const tree = new TreeDoc(new Y.Doc());
		tree.ensureNote("weg.md");
		expect(tree.remove("weg.md")).toBe(true);
		expect(tree.remove("weg.md")).toBe(false);
		expect(tree.entries().size).toBe(0);
	});

	it("tells a watcher what appeared, what left, and both halves of a move", () => {
		const tree = new TreeDoc(new Y.Doc());
		const seen: string[] = [];
		const stop = tree.onChange((change) => {
			for (const path of change.added.keys()) seen.push(`+${path}`);
			for (const path of change.removed.keys()) seen.push(`-${path}`);
		});

		const id = tree.ensureNote("a.md");
		tree.move("a.md", "b.md");
		tree.remove("b.md");
		expect(seen).toEqual(["+a.md", "+b.md", "-a.md", "-b.md"]);
		expect(id).toBeTruthy();

		stop();
		tree.ensureNote("stil.md");
		expect(seen).toHaveLength(4);
	});

	it("two devices' tree edits converge to one map", () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const treeA = new TreeDoc(docA);
		const treeB = new TreeDoc(docB);

		const idA = treeA.ensureNote("van-a.md");
		const idB = treeB.ensureNote("van-b.md");

		// The wire, by hand: exchange updates both ways.
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

		expect(treeA.entries()).toEqual(treeB.entries());
		expect(treeA.docIdFor("van-b.md")).toBe(idB);
		expect(treeB.docIdFor("van-a.md")).toBe(idA);
	});

	it("a folder takes the notes under it out of the tree, and nothing else", () => {
		const tree = new TreeDoc(new Y.Doc());
		const een = tree.ensureNote("Map/een.md");
		tree.ensureNote("Map/diep/twee.md");
		tree.ensureNote("Mapje/anders.md");
		tree.ensureNote("los.md");

		const gone = tree.removeUnder("Map");

		expect(gone).toContain(een);
		expect(gone).toHaveLength(2);
		expect([...tree.entries().keys()].sort()).toEqual(["Mapje/anders.md", "los.md"]);
	});

	it("there is no deleting the vault itself", () => {
		const tree = new TreeDoc(new Y.Doc());
		tree.ensureNote("los.md");
		expect(tree.removeUnder("")).toEqual([]);
		expect(tree.entries().size).toBe(1);
	});

	it("never lets a path leave the vault", () => {
		const tree = new TreeDoc(new Y.Doc());
		expect(() => tree.ensureNote("../buiten.md")).toThrow(/never leaves/);
		expect(normalize("a\\b\\c.md")).toBe("a/b/c.md");
	});

	it("records an attachment without minting a document for it", () => {
		const tree = new TreeDoc(new Y.Doc());
		tree.setAttachment("Bijlagen/foto.png", { hash: "abc", size: 12 });

		expect(tree.attachmentFor("Bijlagen/foto.png")).toEqual({ hash: "abc", size: 12 });
		// The two maps are separate, and an attachment is in neither the note
		// map nor anywhere a document id could come from.
		expect(tree.docIdFor("Bijlagen/foto.png")).toBeUndefined();
		expect(tree.entries().size).toBe(0);
	});

	it("moves an attachment and keeps what it knows about it", () => {
		const tree = new TreeDoc(new Y.Doc());
		tree.setAttachment("foto.png", { hash: "abc", size: 12 });
		tree.moveAttachment("foto.png", "Bijlagen/foto.png");

		expect(tree.attachmentFor("foto.png")).toBeUndefined();
		expect(tree.attachmentFor("Bijlagen/foto.png")).toEqual({ hash: "abc", size: 12 });
		expect(() => tree.moveAttachment("weg.png", "elders.png")).toThrow(/No attachment/);
	});

	it("reports a changed hash as both halves, so nothing deletes what just arrived", () => {
		const tree = new TreeDoc(new Y.Doc());
		const seen: { added: string[]; removed: string[] }[] = [];
		const stop = tree.onAttachmentChange((change) =>
			seen.push({ added: [...change.added.keys()], removed: [...change.removed.keys()] }),
		);

		tree.setAttachment("foto.png", { hash: "abc", size: 1 });
		tree.setAttachment("foto.png", { hash: "def", size: 2 });
		tree.removeAttachment("foto.png");
		stop();
		tree.setAttachment("stil.png", { hash: "x", size: 1 });

		expect(seen).toEqual([
			{ added: ["foto.png"], removed: [] },
			{ added: ["foto.png"], removed: ["foto.png"] },
			{ added: [], removed: ["foto.png"] },
		]);
	});

	it("normalizes an attachment path the way it normalizes a note's", () => {
		const tree = new TreeDoc(new Y.Doc());
		tree.setAttachment("./Bijlagen/foto.png", { hash: "abc", size: 1 });

		expect([...tree.attachments().keys()]).toEqual(["Bijlagen/foto.png"]);
		expect(() => tree.setAttachment("../buiten.png", { hash: "a", size: 1 })).toThrow(
			/never leaves/,
		);
	});
});
