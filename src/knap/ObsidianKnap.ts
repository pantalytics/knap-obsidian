/**
 * Where the rebuilt client meets Obsidian, behind the build-time switch.
 *
 * `KNAP_SERVER_URL` is an esbuild define, empty in every ordinary build.
 * Empty means this whole file registers nothing and the plugin behaves
 * exactly as before; set, it adds the protocol handler and four commands,
 * and one test vault can point at the new server while everything else
 * stays where it is. That is the switch phase 2's plan asks for, and it is
 * build-time on purpose: no screen offers a server field (ADR-0033).
 *
 * The screen words hold: sign in, cloud vault, link, unlink, sync. Nothing
 * here says server, relay or share to a person.
 */

import { Notice, Platform, Plugin, SuggestModal, editorInfoField } from "obsidian";

import type { CloudVault } from "./KnapServer";
import { knapLiveEditing } from "./knapEditor";
import { KnapSync } from "./KnapSync";
import type { KnapLink } from "./KnapSync";
import { ObsidianFileStore } from "./ObsidianFileStore";
import { ObsidianSeenTree } from "./ObsidianSeenTree";
import { KnapSettingsTab, signOutNotice } from "./KnapSettingsTab";
import { SIGNIN_ACTION } from "./SignInFlow";
import { obsidianFetch } from "./obsidianFetch";

declare const KNAP_SERVER_URL: string;

/** What ObsidianKnap needs from the plugin: commands, the handler, settings. */
export interface KnapHost extends Plugin {
	getKnapLink(): KnapLink | null;
	saveKnapLink(value: KnapLink | null): Promise<void>;
}

class CloudVaultPickModal extends SuggestModal<CloudVault> {
	constructor(
		host: KnapHost,
		private readonly vaults: CloudVault[],
		private readonly onPick: (vault: CloudVault) => void,
	) {
		super(host.app);
		this.setPlaceholder("Which cloud vault syncs with this one?");
	}

	getSuggestions(query: string): CloudVault[] {
		const needle = query.toLowerCase();
		return this.vaults.filter((vault) => vault.name.toLowerCase().includes(needle));
	}

	renderSuggestion(vault: CloudVault, el: HTMLElement): void {
		// The name and nothing else. There is one kind of person in a vault,
		// so there is no access level to qualify it with.
		el.createDiv({ text: vault.name });
	}

	onChooseSuggestion(vault: CloudVault): void {
		this.onPick(vault);
	}
}

/**
 * Wire the beta in. Returns null (and does nothing) when the build carries
 * no server address, which is every build but the beta's.
 */
export function registerKnapBeta(host: KnapHost): KnapSync | null {
	const serverUrl = typeof KNAP_SERVER_URL === "string" ? KNAP_SERVER_URL : "";
	if (!serverUrl) {
		return null;
	}

	const device = `${host.app.vault.getName()} on ${Platform.isMobileApp ? "phone" : "desktop"}`;
	const sync = new KnapSync({
		serverUrl,
		deviceName: device,
		fetchFn: obsidianFetch,
		files: new ObsidianFileStore(host.app.vault, host.app.fileManager),
		load: () => host.getKnapLink(),
		save: (value) => host.saveKnapLink(value),
		onRefused: (path, reason) => new Notice(`${path}: ${reason}`),
		makeSeen: (cloudVaultId) =>
			new ObsidianSeenTree(
				host.app.vault.adapter,
				`${host.app.vault.configDir}/plugins/${host.manifest.id}/knap-seen.json`,
				cloudVaultId,
			),
	});

	const signIn = () => sync.signIn((url) => window.open(url));

	const pickAndLink = () =>
		sync.listVaults().then(
			(vaults) =>
				new Promise<void>((resolve, reject) => {
					if (!vaults.length) {
						reject(new Error("No cloud vaults yet. Make one in the Knap panel first."));
						return;
					}
					new CloudVaultPickModal(host, vaults, (vault) => {
						sync
							.link(vault)
							.then(() => {
								new Notice(`Linked. This vault now syncs with ${vault.name}.`);
								resolve();
							})
							.catch(reject);
					}).open();
				}),
		);

	host.addSettingTab(new KnapSettingsTab(host, sync, { signIn, pickAndLink }, serverUrl));

	// Live editing and the cursors on it, for whichever note an editor is
	// showing. Which file that is is Obsidian's answer to give, so it comes
	// in as a function and the extension itself stays testable.
	host.registerEditorExtension(
		knapLiveEditing(sync, (state) => state.field(editorInfoField, false)?.file?.path ?? null),
	);

	host.registerObsidianProtocolHandler(SIGNIN_ACTION, (params) => {
		const fed = sync.handleDeepLink(params as unknown as Record<string, string>);
		if (!fed) {
			// A sign-in that was started somewhere other than here: the link
			// arrives, nothing is waiting for it, and the code is dropped. It
			// used to be dropped in silence, which reads exactly like the
			// plugin being broken -- the browser said it worked and Obsidian
			// said nothing at all.
			new Notice("That sign-in did not start here. Run sign in (beta) and try again.");
		}
	});

	host.addCommand({
		id: "knap-beta-sign-in",
		name: "Sign in (beta)",
		callback: () => {
			signIn()
				.then(() => new Notice("Signed in. Now link this vault to a cloud vault."))
				.catch((error: Error) => new Notice(error.message));
		},
	});

	host.addCommand({
		id: "knap-beta-link-vault",
		name: "Link this vault to a cloud vault (beta)",
		callback: () => {
			pickAndLink().catch((error: Error) => new Notice(error.message));
		},
	});

	host.addCommand({
		id: "knap-beta-sign-out",
		name: "Sign out (beta)",
		callback: () => {
			void sync
				.signOut()
				.then(({ endedRemotely }) => new Notice(signOutNotice(endedRemotely)));
		},
	});

	host.addCommand({
		id: "knap-beta-unlink",
		name: "Unlink from the cloud vault (beta)",
		callback: () => {
			void sync.unlink().then(() => new Notice("Unlinked. Nothing was deleted, anywhere."));
		},
	});

	// A vault that was linked before this start comes back up on its own,
	// and not one moment before the layout is ready. The first thing the
	// binding does is ask Obsidian which notes this vault holds, and a vault
	// that has not finished loading answers that with too few. Since a note
	// missing from disk is now read as a note somebody deleted, starting
	// early would take the rest of the vault out of the cloud with it.
	host.app.workspace.onLayoutReady(() => {
		void sync.start().catch(() => {
			new Notice(
				"Knap could not reach your cloud vault. It will retry when you sign in again.",
			);
		});
	});
	return sync;
}
