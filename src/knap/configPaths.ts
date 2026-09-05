/**
 * Which of Obsidian's own settings files travel with the cloud vault.
 *
 * The rule is a denylist, and that is deliberate: *settings* means the theme,
 * the hotkeys, the snippets **and the plugins** to the person using Obsidian,
 * which is also what Obsidian Sync means by it. A feature that answered a
 * narrower question than its own label would need explaining every time
 * somebody noticed their plugins had not followed (ADR-0094).
 *
 * This file is the plugin's half of a format two repositories read. The
 * server's half is `is_synced_config` in `knap_mcp/providers/filesystem/paths.py`
 * and the two carve-out lists have to say the same thing, or a device offers a
 * file the server answers 422 to and a person reads a sentence about a file
 * they never put anywhere.
 *
 * Pure, no Obsidian imports, so jest reaches every branch.
 */

import { normalize } from "./TreeDoc";

/**
 * Obsidian's configuration directory, by its default name.
 *
 * Obsidian lets a person rename it and settings sync does not follow them
 * there. The server has to be able to judge a path without knowing which vault
 * it came from, so the name is fixed on both sides; the alternative is "any dot
 * directory that is not one of these", which is not a rule anybody can check by
 * reading it. A vault with a renamed config directory syncs its notes and
 * attachments exactly as before.
 *
 * The repo's own lint rule warns about this line, and the warning is left
 * standing rather than silenced: it is the right warning for anybody who finds
 * this constant without the paragraph above it. `ObsidianConfigStore` walks
 * `vault.configDir` like the rule asks, so a renamed directory yields no path
 * this predicate accepts and that vault's settings stay where they are.
 */
export const CONFIG_DIR = ".obsidian";

/** Our own plugin's id, and the folder that must never travel. */
export const OUR_PLUGIN_ID = "synced-vaults";

/**
 * Folders inside the config directory that stay on the device, whatever the
 * switch says.
 *
 * Ours is the only one. `data.json` holds the account token and which cloud
 * vault this local vault is linked to, and `knap-seen.json` holds what this
 * device last agreed with. A device that received another device's copy would
 * be signed in as somebody else and would then argue with it about which notes
 * were deleted, so this is not a preference somebody can turn on.
 */
const REFUSED_PREFIXES = [`plugins/${OUR_PLUGIN_ID}`];

/**
 * Files inside the config directory that stay on the device.
 *
 * Which panes are open, on each of the two kinds of device Obsidian runs on.
 * Obsidian keeps them apart itself, `workspace.json` on desktop and
 * `workspace-mobile.json` on a phone, and neither belongs to a vault: measured
 * at six writes in twenty-five idle seconds against zero for every other file
 * in the directory, so two devices syncing one would never settle. Obsidian
 * Sync does not carry them either.
 */
const REFUSED_FILES = ["workspace.json", "workspace-mobile.json"];

/**
 * Is this path one settings sync carries?
 *
 * Takes a vault path. Normalizes first, because every escape this codebase has
 * seen has been a spelling: `.obsidian/plugins/./synced-vaults/data.json` is
 * our own folder however it is written.
 */
export function isSyncedConfig(vaultPath: string): boolean {
	let clean: string;
	try {
		clean = normalize(vaultPath);
	} catch {
		return false; // leaves the vault; not ours to carry
	}
	const parts = clean.split("/").filter(Boolean);
	if (parts.length < 2 || parts[0] !== CONFIG_DIR) return false;
	const inside = parts.slice(1).join("/");
	if (REFUSED_FILES.includes(inside)) return false;
	return !REFUSED_PREFIXES.some(
		(prefix) => inside === prefix || inside.startsWith(prefix + "/"),
	);
}

/** Anything at all under the config directory, carried or carved out. */
export function isUnderConfigDir(vaultPath: string): boolean {
	const parts = vaultPath.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts[0] === CONFIG_DIR;
}

/**
 * The plugin folder a config path belongs to, or null.
 *
 * `.obsidian/plugins/dataview/main.js` is `dataview`. Used to decide when the
 * roster is worth reloading and which folder's `manifest.json` goes last.
 */
export function pluginFolderOf(vaultPath: string): string | null {
	const parts = normalize(vaultPath).split("/").filter(Boolean);
	if (parts.length < 4) return null;
	if (parts[0] !== CONFIG_DIR || parts[1] !== "plugins") return null;
	return parts[2];
}

/**
 * The order to write a folder's files in.
 *
 * `manifest.json` last, always. Obsidian reads a plugin folder by its
 * manifest, so a folder that has one before it has its `main.js` is a plugin
 * that half exists: it shows up in the list and fails to load. Everything else
 * keeps the order it arrived in, which for a first fill is the order the tree
 * lists it.
 */
export function manifestLast(paths: string[]): string[] {
	const manifests = paths.filter((path) => path.endsWith("/manifest.json"));
	if (manifests.length === 0) return paths;
	const rest = paths.filter((path) => !path.endsWith("/manifest.json"));
	return [...rest, ...manifests];
}
