import { adoptLegacyPlugin, type LegacyAdapter } from "../src/legacyPlugin";

function disk(
	files: Record<string, string>,
): LegacyAdapter & { files: Map<string, string> } {
	const map = new Map(Object.entries(files));
	return {
		files: map,
		exists: async (p) => map.has(p),
		read: async (p) => map.get(p) as string,
		write: async (p, d) => {
			map.set(p, d);
		},
	};
}

const OLD = ".obsidian/plugins/synced-vaults";
const NEW = ".obsidian/plugins/pantalytics";

describe("adoptLegacyPlugin", () => {
	it("takes the old settings over and turns the old plugin off", async () => {
		const fs = disk({
			[`${OLD}/data.json`]: '{"token":"t"}',
			[`${OLD}/knap-seen.json`]: "{}",
		});
		const off: string[] = [];
		const plugins = {
			enabledPlugins: new Set(["synced-vaults"]),
			disablePluginAndSave: async (id: string) => {
				off.push(id);
			},
		};

		const got = await adoptLegacyPlugin(fs, plugins, ".obsidian");

		expect(got).toEqual({
			copied: ["data.json", "knap-seen.json"],
			disabled: true,
		});
		expect(fs.files.get(`${NEW}/data.json`)).toBe('{"token":"t"}');
		expect(fs.files.get(`${NEW}/knap-seen.json`)).toBe("{}");
		expect(off).toEqual(["synced-vaults"]);
		// The old folder stays: deleting it is the person's call.
		expect(fs.files.has(`${OLD}/data.json`)).toBe(true);
	});

	it("never overwrites settings this plugin already has", async () => {
		const fs = disk({
			[`${OLD}/data.json`]: "old",
			[`${NEW}/data.json`]: "new",
		});
		const got = await adoptLegacyPlugin(fs, {}, ".obsidian");
		expect(got.copied).toEqual([]);
		expect(fs.files.get(`${NEW}/data.json`)).toBe("new");
	});

	it("does nothing on a device that never had the old plugin", async () => {
		const fs = disk({});
		const got = await adoptLegacyPlugin(
			fs,
			{ enabledPlugins: new Set() },
			".obsidian",
		);
		expect(got).toEqual({ copied: [], disabled: false });
		expect(fs.files.size).toBe(0);
	});
});

describe("the plugin id", () => {
	it("is the one the manifests carry", () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { PLUGIN_ID } = require("../src/pluginId");
		for (const file of ["../manifest.json"]) {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			expect(require(file).id).toBe(PLUGIN_ID);
		}
	});
});
