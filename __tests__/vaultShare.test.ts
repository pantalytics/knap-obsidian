import {
	decideVaultShare,
	joinButtonLabel,
	joinPreviewLines,
	newVaultBesideLine,
	planFolderCleanup,
	replaceFoldersConfirmation,
	replaceFoldersFailedLine,
	replaceFoldersLine,
	FIRST_SYNC_LINES,
	JOIN_HELD_NOTE,
	REPLACE_FOLDERS_LABEL,
	VAULT_NAME_IS_THE_KEY,
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

describe("the name is the key, and now it says so (#42)", () => {
	test("the rule is on the screen in the words the code follows", () => {
		// decideVaultShare matches on `share.path === vaultName` and nothing
		// else. Until this line existed, nothing anywhere said so.
		const said = VAULT_NAME_IS_THE_KEY.toLowerCase();
		expect(said).toContain("name");
		expect(said).toContain("second vault");
	});

	test("the rule says what to do about it, not only what happens", () => {
		// The row carries the vault's name in its value; this is the line under
		// it, so it has to stand on its own without repeating the name.
		const said = VAULT_NAME_IS_THE_KEY.toLowerCase();
		expect(said).toContain("same name");
		expect(said).toContain("another device");
	});

	test("what will be joined is named before it is joined", () => {
		const said = joinPreviewLines({ vaultName: "Second Brain" }).join(" ");
		expect(said).toContain("Knap already has a vault called Second Brain");
		expect(said).toContain("The name is the only thing Knap matches on");
	});

	test("the day the vault was made is the one fact that settles it", () => {
		// The share record carries created_at. It is the difference between the
		// vault somebody made yesterday and one from months ago that went bad.
		const said = joinPreviewLines({
			vaultName: "V",
			createdAt: "2026-08-11T09:14:00Z",
		}).join(" ");
		expect(said).toContain("added to Knap on 11 August 2026");
	});

	test("a date Knap did not send is left out rather than guessed at", () => {
		for (const createdAt of [undefined, "", "the other day"]) {
			const said = joinPreviewLines({ vaultName: "V", createdAt }).join(" ");
			expect(said).not.toContain("added to Knap on");
			expect(said).not.toContain("Invalid");
		}
	});

	test("no note count and no device count, because Knap will not say", () => {
		// The issue asked for "N notes and 2 other devices". A share record has
		// neither, the files index is the web publishing artifact list and reads
		// 0 on a private vault, and there is no device list on this side of the
		// API at all. Saying what is known beats inventing the rest.
		const said = joinPreviewLines({
			vaultName: "V",
			createdAt: "2026-08-11T09:14:00Z",
		}).join(" ");
		expect(said).not.toMatch(/\d+ notes?\b/);
		expect(said).not.toMatch(/\d+ (other )?devices?\b/);
	});

	test("the way out is named too, and it is the one that works", () => {
		// Renaming the local vault before connecting is what was used on
		// 2026-08-11 to avoid rejoining a vault that had gone bad. It works
		// precisely because the name is the key.
		const said = joinPreviewLines({ vaultName: "V" }).join(" ").toLowerCase();
		expect(said).toContain("rename this vault");
	});

	test("the button carries the name, so nobody presses it blind", () => {
		expect(joinButtonLabel("Second Brain")).toBe("Sync with Second Brain");
	});

	test("a new vault beside the ones already there names both sides", () => {
		// The fork as it actually happens: somebody meant to join the vault
		// they made yesterday and the name is one character out. Naming what
		// the account already has beside what this vault is called is the
		// cheapest way to catch it.
		const line = newVaultBesideLine("Note", ["Notes", "Werk"]);
		expect(line).toContain("Notes and Werk");
		expect(line).toContain("this vault is called Note");
		expect(line).toContain("The names do not match");
	});

	test("a long list stops at three and counts the rest", () => {
		const line = newVaultBesideLine("V", ["A", "B", "C", "D", "E"]);
		expect(line).toContain("A, B, C and 2 more");
	});

	test("a first vault on an empty account says nothing about others", () => {
		expect(newVaultBesideLine("Second Brain", [])).toBeUndefined();
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
		VAULT_NAME_IS_THE_KEY,
		JOIN_HELD_NOTE,
		joinButtonLabel("Second Brain"),
		...joinPreviewLines({ vaultName: "Second Brain" }),
		...joinPreviewLines({ vaultName: "V", createdAt: "2026-08-11T09:14:00Z" }),
		newVaultBesideLine("Note", ["Notes"]) ?? "",
		newVaultBesideLine("Note", ["Notes", "Werk", "Archief", "Oud"]) ?? "",
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
