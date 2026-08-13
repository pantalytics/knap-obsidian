"use strict";

/**
 * Two things about this vault that the plugin can see and used to say nothing
 * about (#41, parts 2 and 3).
 *
 * Both are the same shape: something else is already syncing the directory
 * Knap is about to sync. One vault in the migration on 2026-08-11 had three
 * sync plugins on at once, `system3-relay`, `knap-sync` and `synced-vaults`,
 * and another was connected straight out of
 * `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/` with no complaint
 * from anywhere. `knap-sync` is this plugin's own identifier up to 1.5.0, so
 * the first of those is two copies of Knap writing the same notes at each
 * other, and we are the ones who told people to install it.
 *
 * Pure functions over two strings, no Obsidian imports, so the whole thing can
 * be driven from a test. `vaultScope.ts` and `vaultShare.ts` are the pattern.
 * The one call that touches the app is `readVaultHazards`, and it takes a
 * narrow interface rather than the app.
 *
 * **Which plugins are on is asked of Obsidian, not of a file.** Up to 1.9.0
 * this read `.obsidian/community-plugins.json`, and a person who uninstalled
 * Relay by System 3 and restarted was still refused. Measured on their vault,
 * desktop, 2026-08-12: **Obsidian does not take a plugin's id out of
 * `community-plugins.json` when the plugin is uninstalled.** The file records
 * what was once switched on, not what is here now, and we read it as the
 * second thing. Deleting the line by hand and restarting cleared the refusal,
 * which is not a thing to ask of anybody.
 *
 * So the question is `app.plugins`, which is where Obsidian keeps the answer
 * it acts on itself, and the file is not consulted at all, not even as a
 * fallback: a source known to name plugins that are not there cannot be
 * allowed to hold a vault back.
 *
 * **`app.plugins` is only half the question, and the missing half was the
 * likeliest one.** Obsidian Sync ships with Obsidian, so it is a core plugin
 * and lives in `app.internalPlugins`, and up to 1.9.1 this file could not see
 * it: somebody already paying for Obsidian Sync got no warning at all, which
 * is the exact pairing Obsidian's own help and ADR-0004 tell people to avoid.
 * Both lists are asked now, and either can be unreadable without taking the
 * other down.
 *
 * **Neither check sends anything anywhere.** The vault's path is read on this
 * machine, compared against a handful of strings on this machine, and only the
 * name of the service ever reaches a screen. A path like
 * `Clients/Acme/2026 renewal.md` is a fact about somebody's business and no
 * part of it leaves here (ADR-0003).
 */

export type HazardKind = "second-sync-plugin" | "cloud-folder";

export interface Hazard {
	kind: HazardKind;
	/**
	 * Whether a vault that has not started syncing yet is held back until this
	 * is dealt with. A vault already syncing is never torn down for it: see
	 * `readVaultHazards` for why.
	 */
	blocking: boolean;
	/** One line, for the notice at load. */
	notice: string;
	/** What the settings screen says, a paragraph a line. */
	lines: readonly string[];
}

/** A sync plugin we know by name, and what having it on means. */
export interface KnownPlugin {
	id: string;
	/** What the person sees it called in Obsidian's settings. */
	name: string;
	/**
	 * Whether it syncs the same documents Knap does. A second copy of this
	 * plugin, or the one it was forked from, holds the same collaborative
	 * documents open and writes into them. The rest sync the files.
	 */
	sameDocuments: boolean;
	/**
	 * Whether it ships with Obsidian. It decides one word of the copy and
	 * nothing else: a core plugin is turned off under Settings, Core plugins,
	 * and sending somebody to the wrong list is how an instruction stops being
	 * one.
	 */
	core: boolean;
	/** Anything else worth saying about this one in particular. */
	note?: string;
}

/**
 * The sync plugins worth naming, and only those.
 *
 * A list of identifiers is a guess about the world and this one is
 * deliberately short: the two that hold the same documents open, and the three
 * file-level ones common enough to meet. A sync plugin that is not here is not
 * warned about, which is the failure this list has, and it is a smaller
 * failure than warning somebody about a plugin that does no such thing.
 */
const SYNC_PLUGINS: readonly KnownPlugin[] = [
	{
		id: "knap-sync",
		name: "knap-sync",
		sameDocuments: true,
		core: false,
		note: "knap-sync is this plugin under the identifier it had before 1.5.0. That is two copies of Knap on one vault, and we are the ones who told people to install it.",
	},
	{
		id: "system3-relay",
		name: "Relay by System 3",
		sameDocuments: true,
		core: false,
	},
	{
		id: "obsidian-livesync",
		name: "Self-hosted LiveSync",
		sameDocuments: false,
		core: false,
	},
	{ id: "remotely-save", name: "Remotely Save", sameDocuments: false, core: false },
	{ id: "obsidian-git", name: "Git", sameDocuments: false, core: false },
];

/**
 * The sync that ships with Obsidian, which is not a community plugin at all.
 *
 * It was missing from this file until 2026-08-12 and it is the likeliest of
 * the lot: somebody already paying for Obsidian Sync is exactly who arrives
 * with a vault that syncs. `enabledPlugins` never held it, because core
 * plugins live in `app.internalPlugins`, so the one hazard Obsidian's own help
 * warns about was the one we said nothing about
 * (`knap-mcp-admin/docs/adr/0004-a-vault-gets-one-sync-system.md`).
 *
 * It syncs files rather than the documents Knap holds open, so it warns and
 * never holds a vault back, the same as LiveSync and Remotely Save. Turning it
 * off is the person's own migration and not a toggle we should demand mid-setup.
 */
const CORE_SYNC_PLUGINS: readonly KnownPlugin[] = [
	{
		id: "sync",
		name: "Obsidian Sync",
		sameDocuments: false,
		core: true,
		note: "Obsidian's own help says not to run Sync beside another sync, and Knap is another sync. Pick one of the two for this vault.",
	},
];

/** This plugin, which is in the enabled list too and is not a second one. */
export const OWN_PLUGIN_ID = "synced-vaults";

/**
 * The sync plugins loaded beside this one, most serious first.
 *
 * The ids come from `loadedPluginIds`, which is Obsidian's own account of what
 * is running in this vault right now: a plugin sitting in the folder switched
 * off is not in it, and is not a problem either.
 */
export function otherSyncPlugins(
	enabledIds: readonly string[],
	ownId: string = OWN_PLUGIN_ID,
): KnownPlugin[] {
	const enabled = new Set(enabledIds);
	return SYNC_PLUGINS.filter(
		(plugin) => plugin.id !== ownId && enabled.has(plugin.id),
	).sort(bySeverity);
}

/**
 * The core sync plugins switched on, which today is Obsidian Sync or nothing.
 *
 * Kept apart from `otherSyncPlugins` because the two lists come from two
 * places in the app and one of them can be unreadable while the other is fine.
 */
export function coreSyncPlugins(enabledCoreIds: readonly string[]): KnownPlugin[] {
	const enabled = new Set(enabledCoreIds);
	return CORE_SYNC_PLUGINS.filter((plugin) => enabled.has(plugin.id));
}

/** Everything syncing this vault beside Knap, most serious first. */
export function syncPluginsInVault(
	enabledIds: readonly string[],
	enabledCoreIds: readonly string[],
	ownId: string = OWN_PLUGIN_ID,
): KnownPlugin[] {
	return [...otherSyncPlugins(enabledIds, ownId), ...coreSyncPlugins(enabledCoreIds)].sort(
		bySeverity,
	);
}

/** The ones that write the documents Knap holds open come first. */
function bySeverity(a: KnownPlugin, b: KnownPlugin): number {
	return Number(b.sameDocuments) - Number(a.sameDocuments);
}

/**
 * Where in Obsidian's settings these are turned off.
 *
 * One list, or both, and the sentence has to survive either. A person sent to
 * Community plugins to find Obsidian Sync does not find it and concludes the
 * warning is about something else.
 */
function whereToTurnOff(plugins: readonly KnownPlugin[]): string {
	const core = plugins.some((plugin) => plugin.core);
	const community = plugins.some((plugin) => !plugin.core);
	if (core && community) return "under Settings, in Core plugins and Community plugins";
	if (core) return "under Settings, Core plugins";
	return "under Settings, Community plugins";
}

/** The cloud drives whose folders are recognisable from a path. */
const CLOUD_DRIVES: readonly { name: string; segments: readonly string[] }[] = [
	// "Mobile Documents" is the macOS and iOS container, and the vault Obsidian
	// makes for itself on a phone lands in `iCloud~md~obsidian` inside it.
	// "iCloudDrive" is the Windows one.
	{ name: "iCloud Drive", segments: ["Mobile Documents", "iCloudDrive", "iCloud"] },
	{ name: "OneDrive", segments: ["OneDrive"] },
	{ name: "Dropbox", segments: ["Dropbox"] },
	{ name: "Google Drive", segments: ["Google Drive", "GoogleDrive", "My Drive"] },
];

/**
 * Does this path segment name a cloud drive?
 *
 * A prefix rather than an exact match, because the real folders carry the
 * account on the end: `OneDrive - Contoso`, `Dropbox (Personal)`,
 * `GoogleDrive-someone@example.com`, `iCloud~md~obsidian`. What follows the
 * name has to be something other than a letter or a digit, so `Dropboxes` is
 * not Dropbox.
 *
 * A folder somebody called `dropbox-notes` matches, and that is the price of
 * the prefix. It is also the reason this warns rather than refusing: a guess
 * off a string is not grounds for stopping somebody's vault.
 */
function segmentNames(segment: string, drive: string): boolean {
	const s = segment.toLowerCase();
	const d = drive.toLowerCase();
	if (!s.startsWith(d)) return false;
	const rest = s.slice(d.length);
	return rest === "" || /^[^a-z0-9]/.test(rest);
}

/**
 * The cloud drive this vault sits in, if it sits in one.
 *
 * Windows separators are normalised first, and a drive letter or a leading
 * slash is just an empty segment, so both shapes of path walk the same way.
 */
export function cloudFolder(vaultPath: string): string | undefined {
	if (!vaultPath) return undefined;
	const segments = vaultPath.replace(/\\/g, "/").split("/");
	for (const drive of CLOUD_DRIVES) {
		for (const segment of segments) {
			if (drive.segments.some((name) => segmentNames(segment, name))) {
				return drive.name;
			}
		}
	}
	return undefined;
}

/** Plain English for a short list of names. */
function andList(names: readonly string[]): string {
	if (names.length === 0) return "";
	if (names.length === 1) return names[0];
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What to say about the sync plugins that are on beside this one.
 *
 * `syncing` is whether this vault is already going. It changes the answer
 * rather than the finding: a vault that has not started does not start, and a
 * vault that has is left alone and told. Pulling sync out from under a vault
 * mid-fill is not the safer of the two, and the person in the migration this
 * came from had all three plugins on deliberately, part way through a move.
 */
export function syncPluginHazard(
	others: readonly KnownPlugin[],
	syncing: boolean,
): Hazard | undefined {
	if (others.length === 0) return undefined;

	const names = andList(others.map((plugin) => plugin.name));
	const sameDocuments = others.some((plugin) => plugin.sameDocuments);
	const holding = sameDocuments && !syncing;
	const many = others.length > 1;
	const they = many ? "they" : "it";
	const are = many ? "are" : "is";
	const them = many ? "them" : "it";
	// One plugin syncs, two plugins sync. The verb has to move with the
	// pronoun above it, and up to 1.9.0 it did not: "it sync the same notes".
	const sync = many ? "sync" : "syncs";

	const lines: string[] = [
		sameDocuments
			? `${names} ${are} switched on in this vault, and ${they} ${sync} the same notes Knap does. ` +
				"Two systems writing one note means the last write wins and the other one is lost."
			: `${names} ${are} switched on in this vault, and so is Knap. ` +
				"Two sync systems on one vault is how a note comes back as a conflicted copy, or comes back empty.",
	];
	for (const plugin of others) {
		if (plugin.note) lines.push(plugin.note);
	}
	const where = whereToTurnOff(others);
	if (holding) {
		lines.push(
			`Knap has not started syncing this vault. Turn ${them} off ${where}, then come back to this screen.`,
		);
	} else if (sameDocuments) {
		lines.push(
			`This vault is already syncing with Knap, so it carries on. Stopping it half way would cost more than it saves. Turn ${them} off when you get the chance.`,
		);
	} else {
		lines.push(
			`Knap carries on. Turn off the ${many ? "ones" : "one"} you are not using, ${where}.`,
		);
	}

	return {
		kind: "second-sync-plugin",
		blocking: holding,
		notice: holding
			? `${names} ${are} syncing this vault too. Knap has not started.`
			: `${names} ${are} syncing this vault as well as Knap.`,
		lines,
	};
}

/**
 * What to say about a vault that lives in a cloud drive.
 *
 * **The way out is not the same on a phone**, and until 2026-08-12 only the
 * desktop one was offered. Quitting the app and moving a folder is a thing a
 * laptop can do; a phone has no file manager that reaches Obsidian's own
 * storage, and on iOS the vault a person makes in Obsidian is offered in
 * iCloud Drive by default, so this warning is one most phone vaults earn. What
 * a phone can do is make a second vault stored on the device, sign in there and
 * pick the same vault on Knap off the list, which is one press and needs no
 * name typed correctly (`vaultShare.ts`).
 */
export function cloudFolderHazard(
	drive: string | undefined,
	onPhone: boolean = false,
): Hazard | undefined {
	if (!drive) return undefined;
	return {
		kind: "cloud-folder",
		blocking: false,
		notice: `This vault is in ${drive}, and Knap syncs it too.`,
		lines: [
			`This vault sits inside ${drive}, so ${drive} and Knap are both syncing the same files. ` +
				"That is how a note turns into a conflicted copy, or reads as empty here while it is still being fetched.",
			onPhone
				? `Knap carries on. To keep them apart on a phone, make a new vault in Obsidian stored on this device rather than in ${drive}, ` +
					"sign in there, and pick this same vault from the list. Knap fills it from the copy it already has."
				: `Knap carries on. To keep them apart, quit Obsidian, move the vault somewhere ${drive} does not reach, and open it from there.`,
		],
	};
}

/**
 * The one to say first.
 *
 * Two warnings at once is how neither gets read, so the screen shows one and
 * the notice at load names one. Something holding the vault back comes first,
 * because it is the only one with a vault standing still behind it, and the
 * rest wait their turn: fix the first, reopen the screen, meet the second.
 */
export function topHazard(hazards: readonly Hazard[]): Hazard | undefined {
	return hazards.find((hazard) => hazard.blocking) ?? hazards[0];
}

/**
 * Whether this vault is stopped from starting, and by what.
 *
 * The second half of the rule, checked at the screen rather than only when the
 * list was built: a vault that already has its share is never held, whatever
 * the list says. The two guards agree by construction, since `readVaultHazards`
 * is given the same fact. Keeping both is cheap and the failure they prevent
 * is a vault mid-fill being told it is not allowed to sync.
 */
export function holdsVaultBack(
	hazards: readonly Hazard[],
	hasVaultShare: boolean,
): Hazard | undefined {
	if (hasVaultShare) return undefined;
	return hazards.find((hazard) => hazard.blocking);
}

/** The little of the vault this file needs, so it never imports Obsidian. */
export interface VaultReader {
	/** Where the vault sits on this machine. Empty when it cannot be read. */
	basePath: string;
	/**
	 * The plugins Obsidian is running in this vault, this second. Empty when
	 * it will not say, which names no plugins rather than guessing at one.
	 */
	loadedPlugins: readonly string[];
	/**
	 * The core plugins switched on, which is a separate list in a separate
	 * place. Empty when it cannot be read, on the same terms as the one above.
	 */
	loadedCorePlugins: readonly string[];
	/** Whether this is the phone, which changes the way out of a cloud folder. */
	onPhone: boolean;
}

/**
 * What Obsidian keeps about the plugins it has loaded.
 *
 * None of this is in the public `obsidian` types, so it is read defensively
 * and every field is treated as possibly absent, the way `main.ts` reads
 * `appId` and the adapter's base path.
 */
export interface LoadedPlugins {
	/** The ids switched on, as a `Set`. */
	enabledPlugins?: unknown;
	/** The manifests of the plugins installed, keyed by id. */
	manifests?: unknown;
}

/**
 * The plugin ids Obsidian is actually running, or `undefined` when it will not
 * say.
 *
 * Two facts, and a plugin has to satisfy both. `enabledPlugins` is the set of
 * ids switched on, and `manifests` holds one entry per plugin installed, so an
 * id switched on with nothing installed behind it is a plugin that was
 * uninstalled and cannot be writing to anything. That pair is the fix for the
 * 1.9.0 refusal: `.obsidian/community-plugins.json` still listed
 * `system3-relay` after the uninstall and a restart, measured on the affected
 * vault on 2026-08-12, and neither of these did.
 *
 * `undefined` means the shape was not what we expect, which is a different
 * thing from an empty vault and is why it is not an empty array. Obsidian
 * moving this is a warning we can no longer give, not a vault we hold.
 */
export function loadedPluginIds(plugins: LoadedPlugins | undefined): string[] | undefined {
	const enabled = plugins?.enabledPlugins;
	if (!(enabled instanceof Set)) return undefined;
	const ids = [...enabled].filter((id): id is string => typeof id === "string");
	const manifests = plugins?.manifests;
	if (typeof manifests !== "object" || manifests === null) return ids;
	const installed = manifests as Record<string, unknown>;
	return ids.filter((id) => Boolean(installed[id]));
}

/**
 * What Obsidian keeps about its own plugins, the ones that ship with it.
 *
 * A record keyed by id, each entry carrying at least whether it is on. Not in
 * the public types either, and read the same defensive way: `main.ts` already
 * leans on this exact shape for `internalPlugins.plugins.webviewer.enabled`.
 */
export interface CorePlugins {
	plugins?: unknown;
}

/**
 * The core plugin ids switched on, or `undefined` when the app will not say.
 *
 * **The id this exists for is `sync`, and it is the one thing here nobody has
 * measured in a running Obsidian.** It is read off Obsidian's own core plugin
 * vocabulary rather than off the app, which by this repo's rule makes it worth
 * naming rather than asserting
 * (`knap-mcp-admin/docs/adr/0018-check-upstream-before-designing-on-it.md`).
 * The cost of being wrong is bounded to what we already had: a wrong id
 * matches nothing, nothing is warned about, and no vault is held, because the
 * core entry warns rather than blocks. One line settles it:
 *
 * ```
 * obsidian.sh eval "Object.entries(app.internalPlugins.plugins)
 *   .filter(([, p]) => p.enabled).map(([id]) => id)"
 * ```
 */
export function enabledCorePluginIds(core: CorePlugins | undefined): string[] | undefined {
	const plugins = core?.plugins;
	if (typeof plugins !== "object" || plugins === null) return undefined;
	return Object.entries(plugins as Record<string, unknown>)
		.filter(([, plugin]) => (plugin as { enabled?: unknown } | null)?.enabled === true)
		.map(([id]) => id);
}

/**
 * Everything this vault has to be told, most serious first.
 *
 * **A blocking hazard stops a vault starting. It never stops one that is
 * already going**, which is what `syncing` is here to decide. Refusing to
 * begin costs somebody a toggle; pulling sync out from under a vault halfway
 * through costs them the afternoon, and disconnecting a vault is not obviously
 * the safer of the two anyway.
 *
 * Nothing here reads a file, so nothing here is stale: the plugins are the
 * ones loaded at the moment somebody asks, and turning one off and reopening
 * this screen clears the finding. A vault with no community plugins names
 * none, which is the ordinary case and not an error.
 */
export function readVaultHazards(vault: VaultReader, syncing: boolean): Hazard[] {
	const hazards: Hazard[] = [];

	const plugins = syncPluginHazard(
		syncPluginsInVault(vault.loadedPlugins, vault.loadedCorePlugins),
		syncing,
	);
	if (plugins) hazards.push(plugins);

	const cloud = cloudFolderHazard(cloudFolder(vault.basePath), vault.onPhone);
	if (cloud) hazards.push(cloud);

	return hazards;
}
