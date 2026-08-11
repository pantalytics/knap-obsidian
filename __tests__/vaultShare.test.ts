import {
	decideVaultShare,
	planFolderCleanup,
	replaceFoldersConfirmation,
	replaceFoldersFailedLine,
	replaceFoldersLine,
	FIRST_SYNC_LINES,
	REPLACE_FOLDERS_LABEL,
	type LocalShare,
	type ShareLike,
} from "../src/vaultShare";

const folderShare = (path: string, id = "s1"): ShareLike => ({
	id,
	kind: "folder",
	path,
});

/** The default state, and the only one a new install can be in. */
const fresh = {
	hasVaultShare: false,
	folderShareCount: 0,
} as const;

describe("what signing in does about the whole vault", () => {
	test("nothing shared yet: create a share named after the vault", () => {
		expect(decideVaultShare("Second Brain", [], fresh)).toEqual({
			action: "create",
			path: "Second Brain",
		});
	});

	test("the path is never empty, which the control plane refuses", () => {
		// ShareCreate.path is minLength 1, read off the running control plane's
		// OpenAPI on 2026-08-11. An empty vault name would be a 422.
		const decision = decideVaultShare("V", [], fresh);
		expect(decision).toEqual({ action: "create", path: "V" });
		if (decision.action === "create") {
			expect(decision.path.length).toBeGreaterThan(0);
		}
	});

	test("a second device adopts the share already on the server", () => {
		const share = folderShare("Second Brain", "abc");
		expect(decideVaultShare("Second Brain", [share], fresh)).toEqual({
			action: "adopt",
			share,
		});
	});

	test("a share of the same name but the wrong kind is not the vault", () => {
		const doc: ShareLike = { id: "d1", kind: "doc", path: "Second Brain" };
		expect(decideVaultShare("Second Brain", [doc], fresh)).toEqual({
			action: "create",
			path: "Second Brain",
		});
	});

	test("somebody else's shares on the same account are left alone", () => {
		const others = [folderShare("Clients", "c1"), folderShare("Personal/Reading list", "r1")];
		expect(decideVaultShare("Second Brain", others, fresh)).toEqual({
			action: "create",
			path: "Second Brain",
		});
	});

	test("already syncing whole: signing in again does nothing", () => {
		expect(
			decideVaultShare("Second Brain", [folderShare("Second Brain")], {
				...fresh,
				hasVaultShare: true,
			}),
		).toEqual({ action: "already-syncing" });
	});

	test("folder shares from an older build ask to be replaced", () => {
		// Whole vault and folder shares are exclusive both ways
		// (SharedFolder._new), so creating the vault share on top of them would
		// throw. Taking a share off deletes its documents, so the screen asks
		// rather than doing it on sign-in.
		expect(
			decideVaultShare("Second Brain", [], { ...fresh, folderShareCount: 2 }),
		).toEqual({ action: "replace-folders", count: 2 });
	});

	test("a vault share beside a leftover folder is still already-syncing", () => {
		// A clean-up that stopped halfway. Saying already-syncing is what is
		// true, and it keeps the screen from offering to start something that
		// is running.
		expect(
			decideVaultShare("Second Brain", [], {
				hasVaultShare: true,
				folderShareCount: 1,
			}),
		).toEqual({ action: "already-syncing" });
	});
});

describe("clearing folder shares out of the way", () => {
	const vaultShare: LocalShare = { id: "v1", isVaultScope: true };
	const clients: LocalShare = { id: "f1", isVaultScope: false };
	const personal: LocalShare = { id: "f2", isVaultScope: false };

	test("every folder share comes off", () => {
		expect(planFolderCleanup([clients, personal])).toEqual(["f1", "f2"]);
	});

	test("a vault share is never in the list", () => {
		expect(planFolderCleanup([vaultShare, clients])).toEqual(["f1"]);
	});

	test("nothing to do is an empty list, not a create", () => {
		expect(planFolderCleanup([])).toEqual([]);
		expect(planFolderCleanup([vaultShare])).toEqual([]);
	});

	test("it plans from this vault's shares, so another vault's are untouched", () => {
		// The list handed in is the local records, which exist only for shares
		// this vault syncs. A share on the same account for a different vault
		// has no record here and so cannot appear.
		expect(planFolderCleanup([clients])).not.toContain("someone-elses-share");
	});
});

describe("the copy that goes with it", () => {
	test("the wait says what does not travel", () => {
		const second = FIRST_SYNC_LINES[1].toLowerCase();
		expect(second).toContain("settings");
		expect(second).toContain("themes");
		expect(second).toContain("plugins");
	});

	/** Every string this module puts in front of a person. */
	const onScreen = (): string[] => [
		...FIRST_SYNC_LINES,
		REPLACE_FOLDERS_LABEL,
		replaceFoldersLine(1),
		replaceFoldersLine(4),
		replaceFoldersConfirmation(1),
		replaceFoldersConfirmation(3),
		replaceFoldersFailedLine("503"),
	];

	test("no em-dashes anywhere in it", () => {
		for (const line of onScreen()) {
			expect(line).not.toContain("—");
		}
	});

	test("none of it says share, which is not one of the four words", () => {
		// The screens say vault, folder and sync, and the words table in
		// docs/ui-ux.md is the list. Share is the control plane's noun and
		// stays in the code, where the comments above use it freely.
		for (const line of onScreen()) {
			expect(line.toLowerCase()).not.toContain("share");
		}
	});

	test("the leftover line counts in words a person would use", () => {
		expect(replaceFoldersLine(1)).toContain("one folder");
		expect(replaceFoldersLine(3)).toContain("3 folders");
	});

	test("the leftover line says what happens instead, not just what stops", () => {
		// Otherwise it reads as Knap taking the sync away.
		expect(replaceFoldersLine(2).toLowerCase()).toContain("everything syncs");
	});

	test("the confirmation says the notes on the device are safe", () => {
		for (const line of [
			replaceFoldersConfirmation(1),
			replaceFoldersConfirmation(2),
		]) {
			expect(line.toLowerCase()).toContain("not touched");
			expect(line.toLowerCase()).toContain("from scratch");
		}
	});

	test("the confirmation counts what it is about to remove", () => {
		expect(replaceFoldersConfirmation(1)).toContain("Your synced folder");
		expect(replaceFoldersConfirmation(3)).toContain("Your 3 synced folders");
	});

	test("a refusal does not claim nothing happened", () => {
		// With several folders to remove, some may have come off before the
		// refusal. Claiming nothing happened would be the wrong half true.
		const line = replaceFoldersFailedLine("503").toLowerCase();
		expect(line).toContain("nothing else has changed");
		expect(line).toContain("503");
	});
});
