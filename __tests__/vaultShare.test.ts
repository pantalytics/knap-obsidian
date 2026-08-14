import {
	cloudVaults,
	decideVaultShare,
	JOIN_CONFIRMATION,
	planFolderCleanup,
	replaceFoldersConfirmation,
	replaceFoldersFailedLine,
	replaceFoldersLine,
	vaultRowLines,
	CHOOSE_A_VAULT,
	JOIN_LABEL,
	LINKED_TO_LABEL,
	linkedToLine,
	NEW_VAULT_LABEL,
	NO_VAULTS_YET,
	UNLINK_EXPLANATION,
	UNLINK_LABEL,
	VAULT_SCOPE_NOTE,
	REPLACE_FOLDERS_LABEL,
	type LocalShare,
	type ShareLike,
} from "../src/vaultShare";

const folderShare = (path: string, id = "s1", rest: Partial<ShareLike> = {}): ShareLike => ({
	id,
	kind: "folder",
	path,
	...rest,
});

/** The default state, and the only one a new install can be in. */
const fresh = {
	folderShareCount: 0,
} as const;

describe("what signing in does about the vault", () => {
	test("an account with vaults is asked which one, never told", () => {
		const mine = folderShare("Second Brain", "a");
		const theirs = folderShare("Clients", "b", { is_owner: false });

		expect(decideVaultShare([mine, theirs], fresh)).toEqual({
			action: "choose",
			vaults: [theirs, mine],
		});
	});

	test("a vault called what this one is called is a row like any other", () => {
		// The whole of the old rule: `share.path === vaultName` joined itself.
		// It is gone, and a name that happens to match buys nothing.
		const decision = decideVaultShare([folderShare("Second Brain")], fresh);

		expect(decision.action).toBe("choose");
	});

	test("an empty account is a choice with nothing in it, not an error", () => {
		expect(decideVaultShare([], fresh)).toEqual({ action: "choose", vaults: [] });
	});

	test("already syncing: signing in again does nothing, and names the vault", () => {
		const joined = folderShare("Clients", "c1");
		expect(
			decideVaultShare([joined, folderShare("Second Brain", "s2")], {
				...fresh,
				vaultShareId: "c1",
			}),
		).toEqual({ action: "already-syncing", vault: joined });
	});

	test("a vault Knap no longer lists is still already syncing", () => {
		// Deleted or unshared while this device was away. The sync layer is
		// what reports that, and inventing a name here would be worse.
		expect(decideVaultShare([], { ...fresh, vaultShareId: "gone" })).toEqual({
			action: "already-syncing",
			vault: undefined,
		});
	});

	test("folder shares from an older build ask to be replaced", () => {
		// Whole vault and folder shares are exclusive both ways
		// (SharedFolder._new), so nothing can be joined on top of them. Taking
		// a share off deletes its documents, so the screen asks rather than
		// doing it on sign-in.
		expect(decideVaultShare([], { folderShareCount: 2 })).toEqual({
			action: "replace-folders",
			count: 2,
		});
	});

	test("a vault share beside a leftover folder is still already-syncing", () => {
		// A clean-up that stopped halfway. Saying already-syncing is what is
		// true, and it keeps the screen from offering a list to somebody who is
		// already syncing.
		expect(
			decideVaultShare([], { vaultShareId: "v1", folderShareCount: 1 }),
		).toEqual({ action: "already-syncing", vault: undefined });
	});
});

describe("the list the account reaches", () => {
	test("a published note is not a vault", () => {
		const doc: ShareLike = { id: "d1", kind: "doc", path: "Second Brain" };
		expect(cloudVaults([doc, folderShare("Second Brain")])).toEqual([
			folderShare("Second Brain"),
		]);
	});

	test("vaults somebody shared with this account are on it", () => {
		// `GET /v1/shares` returns owned and member shares together, read off
		// the control plane at 3524558. A vault shared with you is by
		// definition not called what the local vault is called, so name
		// matching could never reach one.
		const theirs = folderShare("Clients", "c1", { is_owner: false });
		expect(cloudVaults([theirs])).toEqual([theirs]);
	});

	test("by name, so every device draws the same list", () => {
		const list = cloudVaults([
			folderShare("werk", "3"),
			folderShare("Archief", "2"),
			folderShare("Second Brain", "1"),
		]);
		expect(list.map((one) => one.path)).toEqual(["Archief", "Second Brain", "werk"]);
	});

	test("two vaults of the same name both stay, in a fixed order", () => {
		const list = cloudVaults([folderShare("Notes", "b"), folderShare("Notes", "a")]);
		expect(list.map((one) => one.id)).toEqual(["a", "b"]);
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
		// this vault syncs. A vault on the same account this device has nothing
		// to do with has no record here and so cannot appear.
		expect(planFolderCleanup([clients])).not.toContain("someone-elses-share");
	});
});

describe("what a row says about a vault", () => {
	test("the day it was made, which is what tells two apart", () => {
		expect(vaultRowLines(folderShare("V", "1", { created_at: "2026-08-11T09:14:00Z" }))).toEqual(
			["Added to Knap on 11 August 2026"],
		);
	});

	test("a date Knap did not send is left out rather than guessed at", () => {
		for (const created_at of [undefined, "", "the other day"]) {
			expect(vaultRowLines(folderShare("V", "1", { created_at }))).toEqual([]);
		}
	});

	test("somebody else's vault says so", () => {
		expect(vaultRowLines(folderShare("Clients", "1", { is_owner: false }))).toEqual([
			"Someone else's vault",
		]);
	});

	test("your own says nothing about ownership, because that is the ordinary case", () => {
		expect(vaultRowLines(folderShare("V", "1", { is_owner: true }))).toEqual([]);
		expect(vaultRowLines(folderShare("V"))).toEqual([]);
	});

	test("no note count and no device count, because Knap will not say", () => {
		// A share record has neither, the files index is the web publishing
		// artifact list and reads 0 on a private vault, and there is no device
		// list on this side of the API at all.
		const said = vaultRowLines(
			folderShare("V", "1", { created_at: "2026-08-11T09:14:00Z", is_owner: false }),
		).join(" ");
		expect(said).not.toMatch(/\d+ notes?\b/);
		expect(said).not.toMatch(/\d+ (other )?devices?\b/);
	});
});

describe("joining one, and starting one", () => {
	test("the buttons are one word each", () => {
		// The row carries the vault's name a centimetre to the left, and the
		// local vault's name is the word at the top of the window. Repeating
		// either in a button label is the same string twice on one line.
		//
		// Link rather than Sync since ADR-0063: pressing it answers which cloud
		// vault this local vault belongs to, and the syncing follows from the
		// answer.
		expect(JOIN_LABEL).toBe("Link");
		expect(NEW_VAULT_LABEL).toBe("Create new");
	});

	test("nothing under the list explains the list", () => {
		// The heading is a label, not an instruction: rows that are vaults with
		// a Sync button on them do not need a sentence saying to pick one.
		expect(CHOOSE_A_VAULT).toBe("Cloud vaults");
		expect(NO_VAULTS_YET).toBe("No cloud vaults yet.");
	});

	test("joining says the two halves sync, and what that leaves behind", () => {
		expect(JOIN_CONFIRMATION).toBe(
			"This will sync your local and cloud vault. " +
				"If both vaults contain notes, the result is the combination. " +
				"No data is lost.",
		);
	});

	test("it ends on the thing somebody is actually afraid of", () => {
		// Three sentences, and the last one answers the question being asked. It
		// stays last and it stays short enough to be read.
		const sentences = JOIN_CONFIRMATION.split(". ");
		expect(sentences).toHaveLength(3);
		expect(sentences[2]).toBe("No data is lost.");
	});

	test("it names no vault and counts no file", () => {
		// The same three sentences about every vault, so it is a constant rather
		// than a sentence assembled around a name that can be forty characters of
		// date and initials, or a file count nobody is being asked to check.
		expect(JOIN_CONFIRMATION).not.toMatch(/\d/);
	});
});

describe("the copy that goes with it", () => {
	test("the one note says what does not travel", () => {
		const note = VAULT_SCOPE_NOTE.toLowerCase();
		expect(note).toContain("settings");
		expect(note).toContain("themes");
		expect(note).toContain("plugins");
	});

	test("nothing on screen claims a name matches anything", () => {
		for (const line of onScreen()) {
			expect(line.toLowerCase()).not.toContain("the same name");
			expect(line.toLowerCase()).not.toContain("matches on");
		}
	});

	// The screen said this twice at once: the status row's own instruction and
	// the first sync line under it were the same sentence. A bar replaced both,
	// so nothing here may go back to telling somebody to wait.
	test("nothing tells anybody to leave Obsidian open", () => {
		for (const line of onScreen()) {
			expect(line.toLowerCase()).not.toContain("leave obsidian open");
		}
	});

	/** Every string this module puts in front of a person. */
	const onScreen = (): string[] => [
		VAULT_SCOPE_NOTE,
		CHOOSE_A_VAULT,
		NO_VAULTS_YET,
		JOIN_LABEL,
		NEW_VAULT_LABEL,
		JOIN_CONFIRMATION,
		...vaultRowLines(
			folderShare("V", "1", { created_at: "2026-08-11T09:14:00Z", is_owner: false }),
		),
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

describe("ending the link", () => {
	test("the button is one word, and it is not Delete", () => {
		expect(UNLINK_LABEL).toBe("Unlink");
		expect(LINKED_TO_LABEL).toBe("Linked to");
	});

	test("what it says is what survives, because the risk is reading as a delete", () => {
		// Delete vault takes the documents with it (ADR-0047). This takes
		// nothing, and somebody about to press it has no way to know that
		// unless the sentence beside it says so.
		const said = UNLINK_EXPLANATION.toLowerCase();
		expect(said).toContain("stay on this device");
		expect(said).toContain("keeps everything in it");
		expect(said).toContain("link again");
	});

	test("and it never says delete, remove or lose", () => {
		expect(UNLINK_EXPLANATION).not.toMatch(/delete|remove|lost|lose/i);
	});

	test("no machine word reaches it", () => {
		// ADR-0038: share, relay and control plane stay off a screen.
		for (const copy of [UNLINK_EXPLANATION, UNLINK_LABEL, LINKED_TO_LABEL]) {
			expect(copy).not.toMatch(/\bshare\b|\brelay\b|control plane|workspace/i);
		}
	});
});

describe("the line in front of the list", () => {
	test("names the cloud vault this one already answers to", () => {
		const said = linkedToLine("Second Brain");
		expect(said).toContain("Second Brain");
		// Changing a link is a different act from answering the first time, and
		// this sentence is the only thing on the screen that says so (#71).
		expect(said).toMatch(/stops syncing with that one/);
	});

	test("says so plainly when there is no link yet", () => {
		for (const nothing of [undefined, ""]) {
			const said = linkedToLine(nothing);
			expect(said).toBe("This vault is not linked to a cloud vault yet.");
		}
	});

	test("it warns about the swap rather than asking a question", () => {
		// The rows underneath are the question. This is the consequence.
		expect(linkedToLine("V")).not.toMatch(/\?/);
	});
});
