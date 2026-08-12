import {
	cloudFolder,
	cloudFolderHazard,
	coreSyncPlugins,
	enabledCorePluginIds,
	holdsVaultBack,
	loadedPluginIds,
	otherSyncPlugins,
	readVaultHazards,
	syncPluginHazard,
	syncPluginsInVault,
	topHazard,
	type Hazard,
	type VaultReader,
} from "../src/vaultHazards";

/**
 * What else is syncing this vault (#41, parts 2 and 3).
 *
 * The two cases in the issue are pinned by name: the migration vault on
 * 2026-08-11 had `system3-relay`, `knap-sync` and `synced-vaults` enabled at
 * once, and another vault was connected straight out of
 * `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/`.
 *
 * The third case is the 1.9.0 regression: a person uninstalled Relay by
 * System 3, restarted Obsidian, and was still refused, because the check read
 * a file rather than asking the app. `a plugin Obsidian is not running` below
 * is that case.
 */

/** A vault, as little of it as this module reads. */
function vault(options: {
	plugins?: string[];
	corePlugins?: string[];
	basePath?: string;
	onPhone?: boolean;
}): VaultReader {
	return {
		basePath: options.basePath ?? "/Users/someone/Notes",
		loadedPlugins: options.plugins ?? [],
		loadedCorePlugins: options.corePlugins ?? [],
		onPhone: options.onPhone ?? false,
	};
}

/** Obsidian, holding the ids it has switched on and the plugins installed. */
function runtime(enabled: string[], installed: string[] = enabled) {
	return {
		enabledPlugins: new Set(enabled),
		manifests: Object.fromEntries(installed.map((id) => [id, { id }])),
	};
}

/** Obsidian's core plugins, which are a record rather than a set. */
function core(enabled: string[], off: string[] = []) {
	return {
		plugins: {
			...Object.fromEntries(enabled.map((id) => [id, { enabled: true }])),
			...Object.fromEntries(off.map((id) => [id, { enabled: false }])),
		},
	};
}

describe("another sync plugin on the same vault", () => {
	test("the vault from the migration, all three at once", () => {
		const found = otherSyncPlugins(["system3-relay", "knap-sync", "synced-vaults"]);
		expect(found.map((one) => one.id)).toEqual(["knap-sync", "system3-relay"]);
	});

	test("this plugin is not a second copy of itself", () => {
		expect(otherSyncPlugins(["synced-vaults"])).toEqual([]);
	});

	test("knap-sync is the one we caused, so it is named as ours", () => {
		const hazard = syncPluginHazard(otherSyncPlugins(["knap-sync"]), false);
		expect(hazard).toBeDefined();
		const said = (hazard as Hazard).lines.join(" ");
		expect(said).toContain("knap-sync");
		expect(said.toLowerCase()).toContain("two copies of knap");
	});

	test("a plugin that syncs the same notes holds a vault that has not started", () => {
		const hazard = syncPluginHazard(otherSyncPlugins(["system3-relay"]), false);
		expect(hazard?.blocking).toBe(true);
		expect(hazard?.lines.join(" ")).toContain("has not started syncing this vault");
	});

	test("the same plugin never stops a vault that is already going", () => {
		// The migration had all three on deliberately, part way through a move.
		// Refusing to begin costs a toggle; disconnecting a vault mid-fill costs
		// the afternoon.
		const hazard = syncPluginHazard(otherSyncPlugins(["system3-relay"]), true);
		expect(hazard?.blocking).toBe(false);
		expect(hazard?.lines.join(" ")).toContain("already syncing with Knap");
		expect(hazard?.lines.join(" ")).not.toContain("has not started");
	});

	test("a file-level sync plugin warns and never holds, going either way", () => {
		for (const syncing of [true, false]) {
			const hazard = syncPluginHazard(otherSyncPlugins(["remotely-save"]), syncing);
			expect(hazard?.blocking).toBe(false);
			expect(hazard?.notice).toContain("Remotely Save");
		}
	});

	test("nothing else on: nothing said", () => {
		expect(syncPluginHazard([], false)).toBeUndefined();
		expect(otherSyncPlugins(["dataview", "templater", "synced-vaults"])).toEqual([]);
	});

	test("two of them are named in one sentence, not two blocks", () => {
		const hazard = syncPluginHazard(
			otherSyncPlugins(["knap-sync", "remotely-save"]),
			false,
		);
		expect(hazard?.notice).toContain("knap-sync and Remotely Save");
	});
});

describe("Obsidian's own sync, which is not a community plugin", () => {
	test("it is found where core plugins live, not in the enabled set", () => {
		// The gap this closes: `loadedPluginIds` reads `app.plugins`, and
		// Obsidian Sync has never been in there. Somebody paying for it got no
		// warning at all, which is the one pairing Obsidian's own help and
		// ADR-0004 both tell people not to make.
		expect(otherSyncPlugins(["sync", "synced-vaults"])).toEqual([]);
		expect(coreSyncPlugins(["sync"]).map((one) => one.name)).toEqual(["Obsidian Sync"]);
	});

	test("a core plugin that is off, or is not sync, is nothing", () => {
		expect(coreSyncPlugins([])).toEqual([]);
		expect(coreSyncPlugins(["graph", "backlink", "daily-notes"])).toEqual([]);
	});

	test("it warns and never holds, the same as the other file-level ones", () => {
		// Turning off a sync somebody pays for is their migration to schedule,
		// not a toggle to demand halfway through setting Knap up (ADR-0004).
		for (const syncing of [true, false]) {
			const hazard = syncPluginHazard(coreSyncPlugins(["sync"]), syncing);
			expect(hazard?.blocking).toBe(false);
			expect(hazard?.notice).toContain("Obsidian Sync");
		}
	});

	test("it sends people to Core plugins, where the switch actually is", () => {
		const hazard = syncPluginHazard(coreSyncPlugins(["sync"]), false);
		expect(hazard?.lines.join(" ")).toContain("Settings, Core plugins");
		expect(hazard?.lines.join(" ")).not.toContain("Community plugins");
	});

	test("one of each names both lists rather than the wrong one", () => {
		const both = syncPluginsInVault(["remotely-save"], ["sync"]);
		expect(both.map((one) => one.name)).toEqual(["Remotely Save", "Obsidian Sync"]);
		expect(syncPluginHazard(both, false)?.lines.join(" ")).toContain(
			"in Core plugins and Community plugins",
		);
	});

	test("a second copy of Knap still outranks it", () => {
		const found = syncPluginsInVault(["remotely-save", "knap-sync"], ["sync"]);
		expect(found.map((one) => one.id)).toEqual(["knap-sync", "remotely-save", "sync"]);
		// And the vault is held, because one of them writes the same documents.
		expect(syncPluginHazard(found, false)?.blocking).toBe(true);
	});

	test("read off the app, on at true and not merely present", () => {
		expect(enabledCorePluginIds(core(["sync", "graph"], ["publish"]))).toEqual([
			"sync",
			"graph",
		]);
		expect(enabledCorePluginIds(core([], ["sync"]))).toEqual([]);
	});

	test("an app that will not say is not a vault without Sync", () => {
		// Same rule as the community half: undefined rather than empty, so the
		// caller logs it instead of quietly warning about nothing.
		expect(enabledCorePluginIds(undefined)).toBeUndefined();
		expect(enabledCorePluginIds({})).toBeUndefined();
		expect(enabledCorePluginIds({ plugins: null })).toBeUndefined();
		expect(enabledCorePluginIds({ plugins: ["sync"] })?.length).toBe(0);
	});

	test("a vault on Obsidian Sync is finally told something", () => {
		const hazards = readVaultHazards(vault({ corePlugins: ["sync"] }), false);
		expect(hazards.map((one) => one.kind)).toEqual(["second-sync-plugin"]);
		expect(holdsVaultBack(hazards, false)).toBeUndefined();
	});
});

describe("a vault inside a cloud drive", () => {
	test("the reported path, straight off a phone's own vault folder", () => {
		expect(
			cloudFolder(
				"/Users/someone/Library/Mobile Documents/iCloud~md~obsidian/Documents/Second Brain",
			),
		).toBe("iCloud Drive");
	});

	test("the accounts on the end of the folder name do not hide it", () => {
		expect(cloudFolder("/Users/someone/OneDrive - Contoso/Notes")).toBe("OneDrive");
		expect(cloudFolder("/Users/someone/Dropbox (Personal)/Notes")).toBe("Dropbox");
		expect(
			cloudFolder("/Users/x/Library/CloudStorage/GoogleDrive-x@example.com/My Drive/V"),
		).toBe("Google Drive");
		expect(cloudFolder("C:\\Users\\someone\\iCloudDrive\\Notes")).toBe("iCloud Drive");
	});

	test("an ordinary vault is not in anything", () => {
		expect(cloudFolder("/Users/someone/Documents/Second Brain")).toBeUndefined();
		expect(cloudFolder("/home/someone/notes")).toBeUndefined();
		expect(cloudFolder("")).toBeUndefined();
	});

	test("a folder that merely begins the same way is not the drive", () => {
		expect(cloudFolder("/Users/someone/Dropboxes/Notes")).toBeUndefined();
		expect(cloudFolder("/Users/someone/OneDriver/Notes")).toBeUndefined();
	});

	test("it warns and never holds, because it is a guess off a string", () => {
		const hazard = cloudFolderHazard("Dropbox");
		expect(hazard?.blocking).toBe(false);
		expect(hazard?.lines.join(" ")).toContain("Knap carries on");
	});

	test("the way out on a phone is not the way out on a laptop", () => {
		// Quitting the app and dragging a folder is desktop advice, and it was
		// the only advice up to 1.9.1. On iOS the vault Obsidian offers to make
		// is in iCloud Drive to begin with, so this is the case most phones
		// land in rather than an edge one.
		const phone = cloudFolderHazard("iCloud Drive", true);
		expect(phone?.blocking).toBe(false);
		const said = phone?.lines.join(" ") ?? "";
		expect(said).not.toContain("quit Obsidian");
		expect(said).toContain("stored on this device");
		// A new vault only joins the one already on Knap if the name matches,
		// so the instruction is wrong without that half (`vaultShare.ts`).
		expect(said).toContain("the same name");
	});

	test("the laptop keeps the instruction a laptop can follow", () => {
		const desktop = cloudFolderHazard("Dropbox", false);
		expect(desktop?.lines.join(" ")).toContain("quit Obsidian");
		expect(cloudFolderHazard("Dropbox")).toEqual(desktop);
	});

	test("the phone reads it off the vault, not off the path", () => {
		const hazards = readVaultHazards(
			vault({
				basePath: "/var/mobile/.../iCloud~md~obsidian/Documents/V",
				onPhone: true,
			}),
			false,
		);
		expect(hazards.map((one) => one.kind)).toEqual(["cloud-folder"]);
		expect(hazards[0].lines.join(" ")).toContain("on a phone");
	});

	test("no path ever reaches the copy, only the name of the drive", () => {
		// A path is a fact about somebody's business (ADR-0003). The check runs
		// on this machine and the warning names Dropbox, not the vault.
		const path = "/Users/someone/Dropbox (Personal)/Clients/Acme";
		const hazard = cloudFolderHazard(cloudFolder(path));
		const said = [hazard?.notice ?? "", ...(hazard?.lines ?? [])].join(" ");
		expect(said).not.toContain("Acme");
		expect(said).not.toContain("/Users");
	});
});

describe("asking Obsidian which plugins are loaded", () => {
	test("a plugin Obsidian is not running does not hold the vault back", () => {
		// The 1.9.0 report, exactly as it came in: Relay by System 3
		// uninstalled, Obsidian restarted, and `community-plugins.json` still
		// carrying the id. Nothing reads that file any more, so the only
		// question left is what the app has loaded.
		const stillInTheFile = ["system3-relay", "synced-vaults"];
		expect(stillInTheFile).toContain("system3-relay");

		const loaded = loadedPluginIds(runtime(["synced-vaults", "dataview"]));
		expect(loaded).not.toContain("system3-relay");

		const hazards = readVaultHazards(vault({ plugins: loaded }), false);
		expect(hazards).toEqual([]);
		expect(holdsVaultBack(hazards, false)).toBeUndefined();
	});

	test("an id switched on with the plugin uninstalled is not a plugin", () => {
		// The other half of the same failure: the id can outlive the install
		// in the enabled set as well as in the file. A plugin with no manifest
		// has no code behind it and cannot be writing to anything.
		expect(
			loadedPluginIds(runtime(["system3-relay", "synced-vaults"], ["synced-vaults"])),
		).toEqual(["synced-vaults"]);
	});

	test("a plugin that is running is still caught", () => {
		const loaded = loadedPluginIds(runtime(["system3-relay", "synced-vaults"]));
		const hazards = readVaultHazards(vault({ plugins: loaded }), false);
		expect(hazards.map((one) => one.kind)).toEqual(["second-sync-plugin"]);
		expect(holdsVaultBack(hazards, false)).toBeDefined();
	});

	test("nothing installed and nothing enabled is a clean vault, not a broken read", () => {
		expect(loadedPluginIds(runtime([]))).toEqual([]);
	});

	test("an app that will not say is not an empty vault", () => {
		// Undefined rather than an empty list, so the caller can say so in the
		// log instead of quietly warning about nothing forever.
		expect(loadedPluginIds(undefined)).toBeUndefined();
		expect(loadedPluginIds({})).toBeUndefined();
		expect(loadedPluginIds({ enabledPlugins: ["system3-relay"] })).toBeUndefined();
		expect(loadedPluginIds({ enabledPlugins: null })).toBeUndefined();
	});

	test("manifests it will not give up are not held against the enabled set", () => {
		// Half an answer is still an answer: the ids are what the warning is
		// built on, and the manifests only ever take names off that list.
		expect(loadedPluginIds({ enabledPlugins: new Set(["system3-relay"]) })).toEqual([
			"system3-relay",
		]);
	});
});

describe("reading it off the vault", () => {
	test("the migration vault, both at once, most serious first", () => {
		const hazards = readVaultHazards(
			vault({
				plugins: ["system3-relay", "knap-sync", "synced-vaults"],
				basePath: "/Users/someone/Library/Mobile Documents/iCloud~md~obsidian/Documents/V",
			}),
			false,
		);
		expect(hazards.map((one) => one.kind)).toEqual([
			"second-sync-plugin",
			"cloud-folder",
		]);
		expect(topHazard(hazards)?.kind).toBe("second-sync-plugin");
	});

	test("only one of them reaches a person, and it is the one holding the vault", () => {
		const warn: Hazard = {
			kind: "cloud-folder",
			blocking: false,
			notice: "n",
			lines: ["l"],
		};
		const hold: Hazard = {
			kind: "second-sync-plugin",
			blocking: true,
			notice: "n",
			lines: ["l"],
		};
		// Whichever order they arrive in.
		expect(topHazard([warn, hold])).toBe(hold);
		expect(topHazard([hold, warn])).toBe(hold);
		expect(topHazard([warn])).toBe(warn);
		expect(topHazard([])).toBeUndefined();
	});

	test("a vault running no other plugins is told nothing", () => {
		expect(readVaultHazards(vault({}), false)).toEqual([]);
	});

	test("the plugins Obsidian names are the ones warned about", () => {
		const hazards = readVaultHazards(vault({ plugins: ["knap-sync"] }), false);
		expect(hazards.map((one) => one.kind)).toEqual(["second-sync-plugin"]);
	});
});

describe("what a hazard actually stops", () => {
	const holding: Hazard = {
		kind: "second-sync-plugin",
		blocking: true,
		notice: "n",
		lines: ["l"],
	};
	const warning: Hazard = {
		kind: "cloud-folder",
		blocking: false,
		notice: "n",
		lines: ["l"],
	};

	test("a vault that has not started does not start", () => {
		expect(holdsVaultBack([holding], false)).toBe(holding);
	});

	test("a vault already syncing is never torn down for it", () => {
		// The migration had three sync plugins on deliberately, mid-move.
		// Disconnecting a vault half way through a fill is not the safe option.
		expect(holdsVaultBack([holding], true)).toBeUndefined();
	});

	test("a warning stops nothing, on a vault in either state", () => {
		expect(holdsVaultBack([warning], false)).toBeUndefined();
		expect(holdsVaultBack([warning], true)).toBeUndefined();
	});

	test("a warning beside a holding one does not shield it", () => {
		expect(holdsVaultBack([warning, holding], false)).toBe(holding);
	});

	test("a clean vault is held by nothing", () => {
		expect(holdsVaultBack([], false)).toBeUndefined();
	});
});

describe("the copy that goes with it", () => {
	/** Every string this module puts in front of a person. */
	const onScreen = (): string[] => {
		const hazards = [
			syncPluginHazard(otherSyncPlugins(["knap-sync"]), false),
			syncPluginHazard(otherSyncPlugins(["knap-sync"]), true),
			syncPluginHazard(otherSyncPlugins(["system3-relay", "knap-sync"]), false),
			syncPluginHazard(otherSyncPlugins(["remotely-save"]), false),
			syncPluginHazard(otherSyncPlugins(["obsidian-git", "obsidian-livesync"]), true),
			syncPluginHazard(coreSyncPlugins(["sync"]), false),
			syncPluginHazard(syncPluginsInVault(["remotely-save"], ["sync"]), true),
			cloudFolderHazard("iCloud Drive"),
			cloudFolderHazard("iCloud Drive", true),
			cloudFolderHazard("OneDrive"),
			cloudFolderHazard("Dropbox"),
		].filter((one): one is Hazard => one !== undefined);
		return hazards.flatMap((one) => [one.notice, ...one.lines]);
	};

	test("no em-dashes anywhere in it", () => {
		for (const line of onScreen()) {
			expect(line).not.toContain("—");
		}
	});

	test("none of it says share, Obsidian server, Knap server or Relay Server", () => {
		// Four words reach a person: vault, folder, sync and MCP. The one
		// third-party plugin named here is called Relay by System 3, which is
		// its name rather than a word for what Knap runs.
		for (const line of onScreen()) {
			const said = line.toLowerCase();
			expect(said).not.toContain("share");
			expect(said).not.toContain("obsidian server");
			expect(said).not.toContain("knap server");
			expect(said).not.toContain("relay server");
		}
	});

	test("every one of them says what to do about it", () => {
		for (const line of onScreen()) {
			expect(line.length).toBeGreaterThan(0);
		}
		const holding = syncPluginHazard(otherSyncPlugins(["knap-sync"]), false);
		expect(holding?.lines.join(" ")).toContain("Community plugins");
		expect(cloudFolderHazard("Dropbox")?.lines.join(" ")).toContain("move the vault");
	});

	test("one plugin syncs and two plugins sync", () => {
		// 1.9.0 shipped "it sync the same notes Knap does". The verb is built
		// from the same count as the pronoun in front of it, so both readings
		// are worth pinning.
		const one = syncPluginHazard(otherSyncPlugins(["system3-relay"]), false);
		expect(one?.lines.join(" ")).toContain("it syncs the same notes Knap does");
		const two = syncPluginHazard(
			otherSyncPlugins(["system3-relay", "knap-sync"]),
			false,
		);
		expect(two?.lines.join(" ")).toContain("they sync the same notes Knap does");
	});

	test("the notice is one line, because it goes in the corner of the screen", () => {
		for (const hazard of [
			syncPluginHazard(otherSyncPlugins(["knap-sync"]), false),
			cloudFolderHazard("Dropbox"),
		]) {
			expect(hazard?.notice).not.toContain("\n");
			expect((hazard as Hazard).notice.length).toBeLessThan(90);
		}
	});
});
