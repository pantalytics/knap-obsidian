/**
 * The config directory, seen through the binding's `ConfigStore` seam.
 *
 * Thin, like `ObsidianFileStore`: every rule lives in `ConfigBinding` where
 * jest can reach it, and this adapter only translates. Three translations are
 * worth naming, and all three are measured rather than assumed
 * (`scripts/spikes/obsidian_config_events/` in the server repo).
 *
 * **The file index cannot see this directory.** `vault.getFiles()` returns
 * nothing under `.obsidian`, so the walk is `adapter.list`, recursively, and
 * the four `vault.on` handlers the other bindings use never fire for it. The
 * event is `vault.on("raw")`, which is the whole vault: every note write
 * reaches it too and the binding filters.
 *
 * **The adapter is not the same object on a phone.** Desktop runs a Node
 * adapter over the real filesystem and mobile runs a Capacitor one, and this
 * file only ever calls the five methods both of them have: `list`, `exists`,
 * `readBinary`, `writeBinary` and `mkdir`. The spike ran on desktop, so mobile
 * is inference rather than measurement, and this is the one file that has to
 * change if it turns out to be wrong. The two device-specific files, the
 * desktop `workspace.json` and the phone's `workspace-mobile.json`, are both
 * carved out in `configPaths.ts`, so neither kind of device sends the other
 * its pane layout.
 *
 * **A plugin folder that appears is not noticed.** Obsidian keeps its roster
 * from the last time it read the folder, so `refreshPlugins` asks it to read
 * again. It does not enable anything: a plugin that arrived starts at the next
 * start of Obsidian, from the `community-plugins.json` that travelled with it,
 * which is also what Obsidian Sync does with community plugins.
 */

import type { App, EventRef } from "obsidian";

import type { ConfigStore } from "./ConfigBinding";
import { isUnderConfigDir } from "./configPaths";

/**
 * How deep to walk the config directory.
 *
 * `.obsidian/plugins/<id>/<file>` is four, and a theme is three. Plugins that
 * ship an assets folder go one deeper, so this allows one more than anything
 * seen in the wild and then stops. A walk with no floor is a walk a symlinked
 * directory can keep going forever.
 */
const MAX_DEPTH = 6;

export class ObsidianConfigStore implements ConfigStore {
	constructor(private readonly app: App) {}

	private get dir(): string {
		return this.app.vault.configDir;
	}

	async list(): Promise<string[]> {
		return this.walk(this.dir, 0);
	}

	private async walk(folder: string, depth: number): Promise<string[]> {
		if (depth > MAX_DEPTH) return [];
		let listing: { files: string[]; folders: string[] };
		try {
			listing = await this.app.vault.adapter.list(folder);
		} catch {
			// A folder that is not there yet is not a fault: a vault whose
			// owner has never opened Appearance has no `themes/`.
			return [];
		}
		const found = [...listing.files];
		for (const child of listing.folders) {
			found.push(...(await this.walk(child, depth + 1)));
		}
		return found;
	}

	async read(path: string): Promise<ArrayBuffer | null> {
		if (!isUnderConfigDir(path)) return null;
		try {
			if (!(await this.app.vault.adapter.exists(path))) return null;
			return await this.app.vault.adapter.readBinary(path);
		} catch {
			return null;
		}
	}

	async write(path: string, content: ArrayBuffer): Promise<void> {
		if (!isUnderConfigDir(path)) return;
		await this.ensureParent(path);
		await this.app.vault.adapter.writeBinary(path, content);
	}

	private async ensureParent(path: string): Promise<void> {
		const parts = path.split("/");
		// Every level, not only the last one: a plugin arriving into a vault
		// that has never had one needs `plugins/` before `plugins/<id>/`.
		for (let i = 1; i < parts.length; i += 1) {
			const folder = parts.slice(0, i).join("/");
			if (!(await this.app.vault.adapter.exists(folder))) {
				await this.app.vault.adapter.mkdir(folder).catch(() => undefined);
			}
		}
	}

	async remove(path: string): Promise<void> {
		if (!isUnderConfigDir(path)) return;
		try {
			if (await this.app.vault.adapter.exists(path)) {
				await this.app.vault.adapter.remove(path);
			}
		} catch {
			// Gone already, or a folder rather than a file. Either way there
			// is nothing here to say to anybody.
		}
	}

	onRawChange(callback: (path: string) => void): () => void {
		// `raw` is real and fires for the config directory, measured, but it
		// is not in Obsidian's typings, so the vault is narrowed here rather
		// than cast at the call site.
		const vault = this.app.vault as unknown as VaultWithRaw;
		const ref = vault.on("raw", (path: string) => callback(path));
		return () => this.app.vault.offref(ref);
	}

	/**
	 * Read the plugin folder again, so a plugin that arrived is in the list.
	 *
	 * Nothing is enabled. On a phone that matters twice over: a plugin whose
	 * manifest says `isDesktopOnly` is on the disk here and will never run,
	 * and Obsidian is the thing that knows that, not us.
	 */
	async refreshPlugins(): Promise<void> {
		const plugins = (this.app as AppWithPlugins).plugins;
		if (!plugins?.loadManifests) return;
		await plugins.loadManifests();
	}
}

/**
 * `app.plugins` is real and undocumented, so it is typed here rather than
 * reached for with a cast at the call site. `loadManifests` is the one method
 * this plugin calls on it, and it is optional because a future Obsidian that
 * renames it should leave settings sync working for everything that is not a
 * plugin.
 */
interface AppWithPlugins extends App {
	plugins?: { loadManifests?: () => Promise<void> };
}

/**
 * The whole-vault file event, which the typings do not carry. It fires for
 * every write in the vault, the config directory included, which is the only
 * reason this binding can see a settings file change at all.
 */
interface VaultWithRaw {
	on(name: "raw", callback: (path: string) => void): EventRef;
}
