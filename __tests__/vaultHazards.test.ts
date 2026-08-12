import {
	cloudFolder,
	cloudFolderHazard,
	holdsVaultBack,
	otherSyncPlugins,
	readVaultHazards,
	syncPluginHazard,
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
 */

/** A vault on disk, as little of it as this module reads. */
function vault(options: {
	plugins?: string[] | string;
	basePath?: string;
	configDir?: string;
}): VaultReader {
	const configDir = options.configDir ?? ".obsidian";
	const body =
		typeof options.plugins === "string"
			? options.plugins
			: JSON.stringify(options.plugins ?? []);
	return {
		configDir,
		basePath: options.basePath ?? "/Users/someone/Notes",
		exists: (path: string) =>
			Promise.resolve(
				options.plugins !== undefined && path === `${configDir}/community-plugins.json`,
			),
		read: (path: string) => {
			if (path !== `${configDir}/community-plugins.json`) {
				return Promise.reject(new Error(`no such file: ${path}`));
			}
			return Promise.resolve(body);
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

describe("reading it off the vault", () => {
	test("the migration vault, both at once, most serious first", async () => {
		const hazards = await readVaultHazards(
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

	test("a vault with no community plugins has no file, which is not an error", async () => {
		expect(await readVaultHazards(vault({}), false)).toEqual([]);
	});

	test("a config directory that is not .obsidian is still read", async () => {
		const hazards = await readVaultHazards(
			vault({ plugins: ["knap-sync"], configDir: ".config" }),
			false,
		);
		expect(hazards.map((one) => one.kind)).toEqual(["second-sync-plugin"]);
	});

	test("a file that will not parse warns about nothing rather than throwing", async () => {
		await expect(
			readVaultHazards(vault({ plugins: "{ not json" }), false),
		).resolves.toEqual([]);
	});

	test("a file holding something other than a list of names is ignored", async () => {
		await expect(
			readVaultHazards(vault({ plugins: '{"enabled": ["knap-sync"]}' }), false),
		).resolves.toEqual([]);
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
			cloudFolderHazard("iCloud Drive"),
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
