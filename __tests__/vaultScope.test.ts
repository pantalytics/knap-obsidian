import {
	checkPath,
	isExcludedPath,
	sharePrefix,
	toVaultPath,
	toVirtualPath,
} from "../src/vaultScope";

describe("sharePrefix", () => {
	it("gives a folder share a trailing separator", () => {
		expect(sharePrefix("folder", "Notes")).toBe("Notes/");
	});

	it("gives a vault share no prefix at all", () => {
		expect(sharePrefix("vault", "")).toBe("");
	});
});

describe("checkPath, folder scope", () => {
	it("accepts a file inside the folder", () => {
		expect(checkPath("folder", "Notes", "Notes/a.md")).toBe(true);
	});

	it("accepts a file nested deeper", () => {
		expect(checkPath("folder", "Notes", "Notes/sub/a.md")).toBe(true);
	});

	it("rejects a sibling that merely shares a prefix", () => {
		// The trailing separator is what makes this false. Without it,
		// "ArchiveOld/a.md" would land in the "Archive" share.
		expect(checkPath("folder", "Archive", "ArchiveOld/a.md")).toBe(false);
	});

	it("rejects a file outside the folder", () => {
		expect(checkPath("folder", "Notes", "Other/a.md")).toBe(false);
	});

	it("does not contain its own root", () => {
		expect(checkPath("folder", "Notes", "Notes")).toBe(false);
	});
});

describe("checkPath, vault scope", () => {
	it("accepts a top level file", () => {
		expect(checkPath("vault", "", "a.md")).toBe(true);
	});

	it("accepts a nested file", () => {
		expect(checkPath("vault", "", "Notes/sub/a.md")).toBe(true);
	});

	it("rejects the vault root itself", () => {
		expect(checkPath("vault", "", "/")).toBe(false);
		expect(checkPath("vault", "", "")).toBe(false);
	});

	it("rejects the config directory", () => {
		expect(checkPath("vault", "", ".obsidian/app.json", "/", ".obsidian")).toBe(
			false,
		);
		expect(
			checkPath("vault", "", ".obsidian/plugins/x/main.js", "/", ".obsidian"),
		).toBe(false);
	});

	it("rejects a config directory that is not called .obsidian", () => {
		expect(checkPath("vault", "", ".config/app.json", "/", ".config")).toBe(
			false,
		);
	});

	it("rejects dotfiles and dot folders even with no configDir given", () => {
		expect(checkPath("vault", "", ".trash/a.md")).toBe(false);
		expect(checkPath("vault", "", ".git/config")).toBe(false);
		expect(checkPath("vault", "", "Notes/.hidden.md")).toBe(false);
	});

	it("rejects traversal", () => {
		expect(checkPath("vault", "", "../outside.md")).toBe(false);
		expect(checkPath("vault", "", "Notes/../../outside.md")).toBe(false);
	});
});

describe("isExcludedPath", () => {
	it("excludes an empty path", () => {
		expect(isExcludedPath("")).toBe(true);
	});

	it("allows an ordinary note", () => {
		expect(isExcludedPath("Notes/a.md", ".obsidian")).toBe(false);
	});

	it("does not exclude a name that merely starts with the config dir", () => {
		expect(isExcludedPath(".obsidianish/a.md", ".obsidian")).toBe(true);
		// It is excluded, but as a dot folder rather than as the config dir.
		expect(isExcludedPath("obsidian-notes/a.md", ".obsidian")).toBe(false);
	});

	it("treats backslashes as separators", () => {
		expect(isExcludedPath(".obsidian\\app.json", ".obsidian")).toBe(true);
	});
});

describe("virtual path round trip", () => {
	it("folder scope strips and restores the prefix", () => {
		const vpath = toVirtualPath("folder", "Notes", "Notes/sub/a.md");
		expect(vpath).toBe("sub/a.md");
		expect(toVaultPath("folder", "Notes", vpath)).toBe("Notes/sub/a.md");
	});

	it("vault scope is the identity", () => {
		const vpath = toVirtualPath("vault", "", "Notes/sub/a.md");
		expect(vpath).toBe("Notes/sub/a.md");
		expect(toVaultPath("vault", "", vpath)).toBe("Notes/sub/a.md");
	});

	it("vault scope keeps a top level file at the top level", () => {
		// The off-by-one this module exists to kill: slicing path.length + 1
		// against an empty prefix would have returned "md".
		expect(toVirtualPath("vault", "", "a.md")).toBe("a.md");
	});
});

