/**
 * The move from `synced-vaults` to `pantalytics` (ADR-0103), on one device.
 *
 * Obsidian keys a plugin by its id, so the new id installs beside the old
 * one rather than over it. On first load this takes the old plugin's
 * settings (the token and which cloud vault this vault is linked to) and
 * what this device last agreed with, then turns the old plugin off: two
 * copies syncing one vault against each other is the failure ADR-0042 warned
 * about. The old folder is left alone; deleting it is the person's call, and
 * it never travels with settings either way.
 */
import { LEGACY_PLUGIN_ID, PLUGIN_ID } from "./pluginId";

/** The files that make a device the same device. */
const CARRIED = ["data.json", "knap-seen.json"];

export interface LegacyAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

export interface LegacyPlugins {
	enabledPlugins?: unknown;
	disablePluginAndSave?(id: string): Promise<void>;
}

export interface Adopted {
	/** Files copied over from the old plugin's folder. */
	copied: string[];
	/** Whether the old plugin was on and is now off. */
	disabled: boolean;
}

export async function adoptLegacyPlugin(
	adapter: LegacyAdapter,
	plugins: LegacyPlugins,
	configDir: string,
): Promise<Adopted> {
	const from = `${configDir}/plugins/${LEGACY_PLUGIN_ID}`;
	const to = `${configDir}/plugins/${PLUGIN_ID}`;
	const copied: string[] = [];

	// Only into an install that has no settings of its own: once this
	// plugin has been used, the old folder is history, not a source.
	if (!(await adapter.exists(`${to}/data.json`))) {
		for (const name of CARRIED) {
			if (await adapter.exists(`${from}/${name}`)) {
				await adapter.write(
					`${to}/${name}`,
					await adapter.read(`${from}/${name}`),
				);
				copied.push(name);
			}
		}
	}

	let disabled = false;
	const enabled = plugins.enabledPlugins;
	if (
		enabled instanceof Set &&
		enabled.has(LEGACY_PLUGIN_ID) &&
		typeof plugins.disablePluginAndSave === "function"
	) {
		await plugins.disablePluginAndSave(LEGACY_PLUGIN_ID);
		disabled = true;
	}
	return { copied, disabled };
}
