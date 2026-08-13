import {
	anythingWrong,
	blockedBy,
	vaultChecklist,
	CHECKLIST_ALL_CLEAR,
	CHECKLIST_BACK_LABEL,
	CHECKLIST_BLOCKED,
	CHECKLIST_CARRY_ON,
	CHECKLIST_NOTE,
	CHECKLIST_TITLE,
	CHECK_AGAIN_LABEL,
	type Check,
} from "../src/vaultChecklist";
import type { VaultReader } from "../src/vaultHazards";

const clean: VaultReader = {
	basePath: "/Users/rutger/Notes",
	loadedPlugins: ["synced-vaults", "dataview"],
	loadedCorePlugins: ["file-explorer", "graph"],
	onPhone: false,
};

const vault = (over: Partial<VaultReader> = {}): VaultReader => ({ ...clean, ...over });
const by = (checks: Check[], kind: Check["kind"]): Check =>
	checks.find((check) => check.kind === kind) as Check;

describe("the three questions, asked out loud", () => {
	test("a clean vault answers all three, and says so rather than staying quiet", () => {
		// This is the difference from the hazards: they hand back the one thing
		// worth warning about and say nothing about what they checked. A person
		// putting their notes in the cloud wants the list.
		const checks = vaultChecklist(clean);

		expect(checks.map((check) => check.kind)).toEqual([
			"obsidian-sync",
			"other-sync-plugin",
			"cloud-folder",
		]);
		expect(checks.every((check) => check.ok)).toBe(true);
		expect(blockedBy(checks)).toBeUndefined();
		expect(anythingWrong(checks)).toBe(false);
	});

	test("Obsidian Sync is caught, and it warns rather than stopping", () => {
		// It ships with Obsidian and lives in the core list, and it syncs files
		// rather than the documents Knap holds open. Turning off a sync
		// somebody pays for is their migration to schedule.
		const checks = vaultChecklist(vault({ loadedCorePlugins: ["sync"] }));
		const check = by(checks, "obsidian-sync");

		expect(check.ok).toBe(false);
		expect(check.blocking).toBe(false);
		expect(check.label).toBe("Obsidian Sync is syncing this vault");
		expect(check.lines.join(" ")).toContain("Core plugins");
		expect(blockedBy(checks)).toBeUndefined();
		expect(anythingWrong(checks)).toBe(true);
	});

	test("a second copy of Knap stops it", () => {
		// `system3-relay` and `knap-sync` hold the same collaborative documents
		// open. Two writers on one note means the last write wins and the other
		// is lost, which is the one failure worth refusing over.
		const checks = vaultChecklist(
			vault({ loadedPlugins: ["synced-vaults", "system3-relay"] }),
		);
		const check = by(checks, "other-sync-plugin");

		expect(check.ok).toBe(false);
		expect(check.blocking).toBe(true);
		expect(check.label).toBe("Relay by System 3 is syncing this vault");
		expect(blockedBy(checks)).toBe(check);
	});

	test("a file-level plugin is named and lets the vault carry on", () => {
		const checks = vaultChecklist(
			vault({ loadedPlugins: ["synced-vaults", "obsidian-git", "remotely-save"] }),
		);
		const check = by(checks, "other-sync-plugin");

		expect(check.ok).toBe(false);
		expect(check.blocking).toBe(false);
		// The order is the known-plugins list, held stable by the severity
		// sort, so two file-level ones read the way that list has them.
		expect(check.label).toBe("Remotely Save and Git are syncing this vault");
		expect(blockedBy(checks)).toBeUndefined();
	});

	test("this plugin is not a second sync plugin", () => {
		expect(by(vaultChecklist(clean), "other-sync-plugin").ok).toBe(true);
	});

	test("a vault in a cloud drive is named, and never stopped", () => {
		// The check is a prefix match on a folder name, which is a guess, and a
		// guess does not get to stop somebody's vault.
		const checks = vaultChecklist(
			vault({ basePath: "/Users/rutger/Dropbox (Personal)/Notes" }),
		);
		const check = by(checks, "cloud-folder");

		expect(check.ok).toBe(false);
		expect(check.blocking).toBe(false);
		expect(check.label).toBe("This vault sits in Dropbox");
		expect(blockedBy(checks)).toBeUndefined();
	});

	test("the phone gets the way out a phone can take", () => {
		const checks = vaultChecklist(
			vault({ basePath: "/Mobile Documents/iCloud~md~obsidian/Documents/Notes", onPhone: true }),
		);
		const said = by(checks, "cloud-folder").lines.join(" ");

		expect(said).not.toContain("quit Obsidian");
		expect(said).toContain("stored on this device");
	});

	test("three things wrong at once is three rows, not one warning", () => {
		// The screen for a vault that is already syncing shows one hazard,
		// deliberately. This one shows everything, because it is a list of
		// things to go and fix before pressing a button.
		const checks = vaultChecklist({
			basePath: "/Users/rutger/Dropbox/Notes",
			loadedPlugins: ["synced-vaults", "system3-relay"],
			loadedCorePlugins: ["sync"],
			onPhone: false,
		});

		expect(checks.filter((check) => !check.ok)).toHaveLength(3);
		expect(blockedBy(checks)?.kind).toBe("other-sync-plugin");
	});

	test("a vault Obsidian will not describe is not held back for it", () => {
		// `loadedPlugins` is empty when the app will not say, which is a
		// different thing from a vault with nothing on. Refusing on a question
		// we could not ask is the worse mistake.
		const checks = vaultChecklist(
			vault({ loadedPlugins: [], loadedCorePlugins: [], basePath: "" }),
		);

		expect(checks.every((check) => check.ok)).toBe(true);
	});
});

describe("the copy that goes with it", () => {
	const onScreen = (): string[] => [
		CHECKLIST_TITLE,
		CHECKLIST_NOTE,
		CHECKLIST_ALL_CLEAR,
		CHECKLIST_CARRY_ON,
		CHECKLIST_BLOCKED,
		CHECK_AGAIN_LABEL,
		CHECKLIST_BACK_LABEL,
		...vaultChecklist(clean).map((check) => check.label),
		...vaultChecklist({
			basePath: "/Users/rutger/OneDrive - Contoso/Notes",
			loadedPlugins: ["synced-vaults", "obsidian-livesync"],
			loadedCorePlugins: ["sync"],
			onPhone: false,
		}).flatMap((check) => [check.label, ...check.lines]),
	];

	test("no em-dashes anywhere in it", () => {
		for (const line of onScreen()) {
			expect(line).not.toContain("—");
		}
	});

	test("none of it says share, which is not one of the four words", () => {
		for (const line of onScreen()) {
			expect(line.toLowerCase()).not.toContain("share");
		}
	});

	test("the rule is said once, and the rows are not repeated under it", () => {
		expect(CHECKLIST_NOTE.toLowerCase()).toContain("one system");
		expect(CHECKLIST_NOTE.toLowerCase()).not.toContain("dropbox");
		expect(CHECKLIST_NOTE.toLowerCase()).not.toContain("obsidian sync");
	});

	test("carrying on says what it costs, and stopping says what clears it", () => {
		expect(CHECKLIST_CARRY_ON.toLowerCase()).toContain("conflicted copy");
		expect(CHECKLIST_BLOCKED.toLowerCase()).toContain("turn it off");
		expect(CHECKLIST_BLOCKED.toLowerCase()).toContain("check again");
	});
});
