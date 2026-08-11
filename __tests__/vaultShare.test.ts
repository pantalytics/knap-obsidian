import {
	decideVaultShare,
	foldersInsteadLine,
	FIRST_SYNC_LINES,
	type ShareLike,
} from "../src/vaultShare";

const folderShare = (path: string, id = "s1"): ShareLike => ({
	id,
	kind: "folder",
	path,
});

describe("what signing in does about the whole vault", () => {
	test("nothing shared yet: create a share named after the vault", () => {
		expect(decideVaultShare("Second Brain", [], { hasVaultShare: false, folderShareCount: 0 }))
			.toEqual({ action: "create", path: "Second Brain" });
	});

	test("the path is never empty, which the control plane refuses", () => {
		// ShareCreate.path is minLength 1, read off the running control plane's
		// OpenAPI on 2026-08-11. An empty vault name would be a 422.
		const decision = decideVaultShare("V", [], { hasVaultShare: false, folderShareCount: 0 });
		expect(decision).toEqual({ action: "create", path: "V" });
		if (decision.action === "create") {
			expect(decision.path.length).toBeGreaterThan(0);
		}
	});

	test("a second device adopts the share already on the server", () => {
		const share = folderShare("Second Brain", "abc");
		expect(
			decideVaultShare("Second Brain", [share], {
				hasVaultShare: false,
				folderShareCount: 0,
			}),
		).toEqual({ action: "adopt", share });
	});

	test("a share of the same name but the wrong kind is not the vault", () => {
		const doc: ShareLike = { id: "d1", kind: "doc", path: "Second Brain" };
		expect(
			decideVaultShare("Second Brain", [doc], {
				hasVaultShare: false,
				folderShareCount: 0,
			}),
		).toEqual({ action: "create", path: "Second Brain" });
	});

	test("somebody else's shares on the same account are left alone", () => {
		const others = [folderShare("Clients", "c1"), folderShare("Personal/Reading list", "r1")];
		expect(
			decideVaultShare("Second Brain", others, {
				hasVaultShare: false,
				folderShareCount: 0,
			}),
		).toEqual({ action: "create", path: "Second Brain" });
	});

	test("already syncing whole: signing in again does nothing", () => {
		expect(
			decideVaultShare("Second Brain", [folderShare("Second Brain")], {
				hasVaultShare: true,
				folderShareCount: 0,
			}),
		).toEqual({ action: "already-syncing" });
	});

	test("folder shares exist: they win, and the vault is left as it is", () => {
		// Whole vault and folder shares are exclusive both ways
		// (SharedFolder._new). Creating the vault share here would throw, and
		// somebody who set up folders did that on purpose.
		expect(
			decideVaultShare("Second Brain", [], { hasVaultShare: false, folderShareCount: 2 }),
		).toEqual({ action: "folders-instead", count: 2 });
	});
});

describe("the copy that goes with it", () => {
	test("the wait says what does not travel", () => {
		const second = FIRST_SYNC_LINES[1].toLowerCase();
		expect(second).toContain("settings");
		expect(second).toContain("themes");
		expect(second).toContain("plugins");
	});

	test("no em-dashes anywhere in it", () => {
		for (const line of FIRST_SYNC_LINES) {
			expect(line).not.toContain("—");
		}
		expect(foldersInsteadLine(1)).not.toContain("—");
	});

	test("the folders line counts in words a person would use", () => {
		expect(foldersInsteadLine(1)).toContain("one folder");
		expect(foldersInsteadLine(3)).toContain("3 folders");
	});

	test("the folders line says the two cannot be combined", () => {
		// Otherwise somebody hunts for a checkbox and meets the error instead.
		expect(foldersInsteadLine(2).toLowerCase()).toContain("cannot be combined");
	});
});
