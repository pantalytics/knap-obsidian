import {
	decideVaultShare,
	foldersInsteadLine,
	foldersToggleHint,
	planModeSwitch,
	switchConfirmation,
	switchedNotice,
	switchFailedLine,
	FIRST_SYNC_LINES,
	FOLDERS_TOGGLE_LABEL,
	type LocalShare,
	type ShareLike,
} from "../src/vaultShare";

const folderShare = (path: string, id = "s1"): ShareLike => ({
	id,
	kind: "folder",
	path,
});

/** The default state: nothing shared, and the setting untouched. */
const fresh = {
	mode: "whole-vault",
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

	test("folder shares exist: they win, and the vault is left as it is", () => {
		// Whole vault and folder shares are exclusive both ways
		// (SharedFolder._new). Creating the vault share here would throw, and
		// somebody who set up folders did that on purpose.
		expect(
			decideVaultShare("Second Brain", [], { ...fresh, folderShareCount: 2 }),
		).toEqual({ action: "folders-instead", count: 2 });
	});

	test("the setting is on and nothing is shared yet: still no vault share", () => {
		// The gap right after the switch. Creating a vault share into it would
		// undo the thing somebody just asked for, and the old guard, folder
		// count above zero, does not cover this.
		expect(
			decideVaultShare("Second Brain", [folderShare("Second Brain")], {
				mode: "folders",
				hasVaultShare: false,
				folderShareCount: 0,
			}),
		).toEqual({ action: "folders-instead", count: 0 });
	});

	test("a vault share that exists is reported even when the setting says folders", () => {
		// A half-finished switch. Saying already-syncing is what is true, and
		// it is what stops the screen claiming folders while the whole vault
		// is still going up.
		expect(
			decideVaultShare("Second Brain", [], {
				mode: "folders",
				hasVaultShare: true,
				folderShareCount: 0,
			}),
		).toEqual({ action: "already-syncing" });
	});
});

describe("switching between the whole vault and folders", () => {
	const vaultShare: LocalShare = { id: "v1", isVaultScope: true };
	const clients: LocalShare = { id: "f1", isVaultScope: false };
	const personal: LocalShare = { id: "f2", isVaultScope: false };

	test("turning folders on removes the vault share and makes nothing", () => {
		expect(planModeSwitch("folders", [vaultShare])).toEqual({
			remove: ["v1"],
			createVaultShare: false,
		});
	});

	test("turning folders off removes every folder share and makes the vault one", () => {
		expect(planModeSwitch("whole-vault", [clients, personal])).toEqual({
			remove: ["f1", "f2"],
			createVaultShare: true,
		});
	});

	test("nothing shared: the switch is a create, or nothing at all", () => {
		expect(planModeSwitch("whole-vault", [])).toEqual({
			remove: [],
			createVaultShare: true,
		});
		expect(planModeSwitch("folders", [])).toEqual({
			remove: [],
			createVaultShare: false,
		});
	});

	test("it plans from this vault's shares, so another vault's are untouched", () => {
		// The list handed in is the local records, which exist only for shares
		// this vault syncs. A share on the same account for a different vault
		// has no record here and so cannot appear in remove.
		const plan = planModeSwitch("whole-vault", [clients]);
		expect(plan.remove).toEqual(["f1"]);
		expect(plan.remove).not.toContain("someone-elses-share");
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
		const lines = [
			...FIRST_SYNC_LINES,
			FOLDERS_TOGGLE_LABEL,
			foldersInsteadLine(0),
			foldersInsteadLine(1),
			foldersToggleHint("folders"),
			foldersToggleHint("whole-vault"),
			switchConfirmation("folders", 1),
			switchConfirmation("whole-vault", 3),
			switchedNotice("folders"),
			switchedNotice("whole-vault"),
			switchFailedLine("whole-vault", "the server said no"),
		];
		for (const line of lines) {
			expect(line).not.toContain("—");
		}
	});

	test("the folders line counts in words a person would use", () => {
		expect(foldersInsteadLine(1)).toContain("one folder");
		expect(foldersInsteadLine(3)).toContain("3 folders");
	});

	test("the folders line says how to get back to everything", () => {
		// Otherwise somebody hunts for a checkbox and meets the error instead.
		expect(foldersInsteadLine(2).toLowerCase()).toContain("cannot be combined");
		expect(foldersInsteadLine(2).toLowerCase()).toContain("turn the setting off");
	});

	test("nothing shared yet reads as a next step, not as a count of zero", () => {
		const line = foldersInsteadLine(0);
		expect(line).not.toContain("0 folders");
		expect(line.toLowerCase()).toContain("right-click");
	});

	test("both confirmations say the notes on the device are safe", () => {
		for (const line of [
			switchConfirmation("folders", 1),
			switchConfirmation("whole-vault", 2),
		]) {
			expect(line.toLowerCase()).toContain("not touched");
			expect(line.toLowerCase()).toContain("from scratch");
		}
	});

	test("the confirmation counts what it is about to remove", () => {
		expect(switchConfirmation("whole-vault", 1)).toContain("Your shared folder");
		expect(switchConfirmation("whole-vault", 3)).toContain("Your 3 shared folders");
	});

	test("with nothing to remove, the confirmation does not claim there is", () => {
		const line = switchConfirmation("whole-vault", 0);
		expect(line).not.toContain("stops syncing");
		expect(line).not.toContain("stop syncing");
		expect(line.toLowerCase()).toContain("uploads from scratch");
	});

	test("a refusal says the setting did not move, not that nothing happened", () => {
		// With several folders to remove, some may have come off before the
		// refusal. Claiming nothing happened would be the wrong half true.
		const line = switchFailedLine("folders", "503").toLowerCase();
		expect(line).toContain("the setting has not changed");
		expect(line).not.toContain("nothing was");
	});
});
