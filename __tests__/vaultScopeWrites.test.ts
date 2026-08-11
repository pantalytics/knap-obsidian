/**
 * The one guard between a remote document and somebody's config directory.
 *
 * A folder share is protected inbound by its own path prefix: a vpath that came
 * off the CRDT can only ever resolve under "Folder/". A vault share has no
 * prefix, and every inbound write goes through `vault.adapter`, which is raw
 * filesystem access rather than Obsidian's file index. `isExcludedPath` is the
 * whole defence.
 *
 * `SharedFolder.assertWritableVPath` is what calls it, on `flush`, `mkdir`,
 * `writeBinary` and `writeConflictCopy`. These tests put the same question the
 * same way that method does, `checkPath(scope, path, getPath(vpath))`, for the
 * vpaths a hostile or careless remote would send. They cannot prove the write
 * methods ask the question: importing SharedFolder pulls in the whole plugin,
 * including two dependencies jest cannot load. Keeping every adapter write
 * behind assertWritableVPath is read, not proven, so add the assert when you
 * add the write.
 */

import { checkPath, toVaultPath } from "../src/vaultScope";

const CONFIG_DIR = ".obsidian";

/** Exactly what assertWritableVPath computes before it decides. */
function mayWrite(
	scope: "vault" | "folder",
	sharePath: string,
	vpath: string,
): boolean {
	const vaultPath = toVaultPath(scope, sharePath, vpath);
	return checkPath(scope, sharePath, vaultPath, "/", CONFIG_DIR);
}

const hostile = [
	".obsidian/plugins/evil/main.js",
	".obsidian/app.json",
	".obsidian/community-plugins.json",
	".trash/deleted.md",
	".git/config",
	"../outside.md",
	"Notes/../../outside.md",
];

describe("a vault share refuses the paths a folder share's prefix used to catch", () => {
	for (const vpath of hostile) {
		test(`refuses ${vpath}`, () => {
			expect(mayWrite("vault", "", vpath)).toBe(false);
		});
	}

	test("an ordinary note at the vault root is allowed", () => {
		expect(mayWrite("vault", "", "a.md")).toBe(true);
		expect(toVaultPath("vault", "", "a.md")).toBe("a.md");
	});

	test("an ordinary attachment in a folder is allowed", () => {
		expect(mayWrite("vault", "", "Attachments/diagram.png")).toBe(true);
		expect(toVaultPath("vault", "", "Attachments/diagram.png")).toBe(
			"Attachments/diagram.png",
		);
	});

	test("a note whose own name starts with a dot is refused", () => {
		// Not an attack, just a file Obsidian hides and we do not sync.
		expect(mayWrite("vault", "", "Notes/.draft.md")).toBe(false);
	});
});

describe("a folder share still has both guards", () => {
	test("climbing out of the folder is refused", () => {
		expect(mayWrite("folder", "Notes", "../.obsidian/app.json")).toBe(false);
		expect(mayWrite("folder", "Notes", "../../outside.md")).toBe(false);
	});

	test("a file inside the folder resolves under the prefix", () => {
		expect(mayWrite("folder", "Notes", "a.md")).toBe(true);
		expect(toVaultPath("folder", "Notes", "a.md")).toBe("Notes/a.md");
	});

	test("a dot folder inside the share is still refused", () => {
		// The prefix alone would allow this one, which is why the exclusion
		// list applies to both scopes rather than only to a vault share.
		expect(mayWrite("folder", "Notes", ".obsidian/app.json")).toBe(false);
	});
});
