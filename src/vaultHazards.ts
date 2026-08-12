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
interface KnownPlugin {
	id: string;
	/** What the person sees it called under Community plugins. */
	name: string;
	/**
	 * Whether it syncs the same documents Knap does. A second copy of this
	 * plugin, or the one it was forked from, holds the same collaborative
	 * documents open and writes into them. The rest sync the files.
	 */
	sameDocuments: boolean;
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
		note: "knap-sync is this plugin under the identifier it had before 1.5.0. That is two copies of Knap on one vault, and we are the ones who told people to install it.",
	},
	{
		id: "system3-relay",
		name: "Relay by System 3",
		sameDocuments: true,
	},
	{ id: "obsidian-livesync", name: "Self-hosted LiveSync", sameDocuments: false },
	{ id: "remotely-save", name: "Remotely Save", sameDocuments: false },
	{ id: "obsidian-git", name: "Git", sameDocuments: false },
];

/** This plugin, which is in the enabled list too and is not a second one. */
export const OWN_PLUGIN_ID = "synced-vaults";

/**
 * The sync plugins enabled beside this one, most serious first.
 *
 * The list comes from `.obsidian/community-plugins.json`, which is the enabled
 * community plugins and nothing else: a plugin sitting in the folder switched
 * off is not in it, and is not a problem either.
 */
export function otherSyncPlugins(
	enabledIds: readonly string[],
	ownId: string = OWN_PLUGIN_ID,
): KnownPlugin[] {
	const enabled = new Set(enabledIds);
	return SYNC_PLUGINS.filter(
		(plugin) => plugin.id !== ownId && enabled.has(plugin.id),
	).sort((a, b) => Number(b.sameDocuments) - Number(a.sameDocuments));
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

	const lines: string[] = [
		sameDocuments
			? `${names} ${are} switched on in this vault, and ${they} sync the same notes Knap does. ` +
				"Two of them writing one note means the last write wins and the other one is lost."
			: `${names} ${are} switched on in this vault, and so is Knap. ` +
				"Two sync systems on one folder is how a note comes back as a conflicted copy, or comes back empty.",
	];
	for (const plugin of others) {
		if (plugin.note) lines.push(plugin.note);
	}
	if (holding) {
		lines.push(
			`Knap has not started syncing this vault. Turn ${them} off under Settings, Community plugins, then come back to this screen.`,
		);
	} else if (sameDocuments) {
		lines.push(
			`This vault is already syncing with Knap, so it carries on. Stopping it half way would cost more than it saves. Turn ${them} off when you get the chance.`,
		);
	} else {
		lines.push(
			`Knap carries on. Turn off the ${many ? "ones" : "one"} you are not using, under Settings, Community plugins.`,
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

/** What to say about a vault that lives in a cloud drive. */
export function cloudFolderHazard(drive: string | undefined): Hazard | undefined {
	if (!drive) return undefined;
	return {
		kind: "cloud-folder",
		blocking: false,
		notice: `This vault is in ${drive}, and Knap syncs it too.`,
		lines: [
			`This vault sits in a ${drive} folder, so ${drive} and Knap are both syncing the same files. ` +
				"That is how a note turns into a conflicted copy, or reads as empty here while it is still being fetched.",
			`Knap carries on. To keep them apart, quit Obsidian, move the vault somewhere ${drive} does not reach, and open it from there.`,
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
	/** Obsidian's config directory, `.obsidian` unless somebody changed it. */
	configDir: string;
	/** Where the vault sits on this machine. Empty when it cannot be read. */
	basePath: string;
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
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
 * A file that is missing or unreadable means no plugins are named. Obsidian
 * writes `community-plugins.json` the first time somebody enables one, so a
 * vault with no community plugins has no file, which is the ordinary case and
 * not an error.
 */
export async function readVaultHazards(
	vault: VaultReader,
	syncing: boolean,
): Promise<Hazard[]> {
	const hazards: Hazard[] = [];

	const plugins = syncPluginHazard(
		otherSyncPlugins(await enabledPlugins(vault)),
		syncing,
	);
	if (plugins) hazards.push(plugins);

	const cloud = cloudFolderHazard(cloudFolder(vault.basePath));
	if (cloud) hazards.push(cloud);

	return hazards;
}

async function enabledPlugins(vault: VaultReader): Promise<string[]> {
	const path = `${vault.configDir}/community-plugins.json`;
	try {
		if (!(await vault.exists(path))) return [];
		const parsed: unknown = JSON.parse(await vault.read(path));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === "string");
	} catch {
		// Nothing here is worth a broken plugin load. A file we cannot read is
		// a warning we cannot give, and the rest of the plugin does not care.
		return [];
	}
}
