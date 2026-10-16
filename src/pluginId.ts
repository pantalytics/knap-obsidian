/**
 * The plugin's manifest id, and the two names it leaves behind.
 *
 * `pantalytics` since ADR-0103: the folder under `.obsidian/plugins/`, the
 * `obsidian://pantalytics/...` deep links, the settings tab and the command
 * prefix. It must equal `id` in manifest.json.
 */
export const PLUGIN_ID = "pantalytics";

/**
 * The id until ADR-0103. Its folder stays on a device after the move, with
 * the old token in it, so it never travels with settings, and the first load
 * of this plugin takes its settings over from it.
 */
export const LEGACY_PLUGIN_ID = "synced-vaults";

/**
 * The prefix of every IndexedDB database and localStorage key. It kept the
 * old word on purpose: renaming it would make every device download every
 * vault again, and nobody sees it.
 */
export const STORAGE_PREFIX = "synced-vaults";
