/**
 * Where the rebuilt client meets Obsidian, behind the build-time switch.
 *
 * `KNAP_SERVER_URL` is an esbuild define, empty in every ordinary build.
 * Empty means this whole file registers nothing and the plugin behaves
 * exactly as before; set, it adds the protocol handler and three commands,
 * and one test vault can point at the new server while everything else
 * stays where it is. That is the switch phase 2's plan asks for, and it is
 * build-time on purpose: no screen offers a server field (ADR-0033).
 *
 * The screen words hold: sign in, cloud vault, link, unlink, sync. Nothing
 * here says server, relay or share to a person.
 */

import { Notice, Platform, Plugin, SuggestModal } from "obsidian";

import type { CloudVault } from "./KnapServer";
import { KnapSync } from "./KnapSync";
import type { KnapLink } from "./KnapSync";
import { ObsidianFileStore } from "./ObsidianFileStore";
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
		el.createDiv({ text: vault.name });
		el.createEl("small", { text: vault.mayWrite ? "you can edit" : "you can read" });
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
	});

	host.registerObsidianProtocolHandler(SIGNIN_ACTION, (params) => {
		const fed = sync.handleDeepLink(params as unknown as Record<string, string>);
		if (!fed) {
			// A sign-in that was started somewhere other than here: the link
			// arrives, nothing is waiting for it, and the code is dropped. It
			// used to be dropped in silence, which reads exactly like the
			// plugin being broken -- the browser said it worked and Obsidian
			// said nothing at all.
			new Notice("That sign-in did not start here. Run Sign in (beta) and try again.");
		}
	});

	host.addCommand({
		id: "knap-beta-sign-in",
		name: "Sign in (beta)",
		callback: () => {
			sync
				.signIn((url) => window.open(url))
				.then(() => new Notice("Signed in. Now link this vault to a cloud vault."))
				.catch((error: Error) => new Notice(error.message));
		},
	});

	host.addCommand({
		id: "knap-beta-link-vault",
		name: "Link this vault to a cloud vault (beta)",
		callback: () => {
			sync
				.listVaults()
				.then((vaults) => {
					if (!vaults.length) {
						new Notice("No cloud vaults yet. Make one in the Knap panel first.");
						return;
					}
					new CloudVaultPickModal(host, vaults, (vault) => {
						sync
							.link(vault)
							.then(() => new Notice(`Linked. This vault now syncs with ${vault.name}.`))
							.catch((error: Error) => new Notice(error.message));
					}).open();
				})
				.catch((error: Error) => new Notice(error.message));
		},
	});

	host.addCommand({
		id: "knap-beta-unlink",
		name: "Unlink from the cloud vault (beta)",
		callback: () => {
			void sync.unlink().then(() => new Notice("Unlinked. Nothing was deleted, anywhere."));
		},
	});

	// A vault that was linked before this start comes back up on its own.
	void sync.start().catch(() => {
		new Notice("Knap could not reach your cloud vault. It will retry when you sign in again.");
	});
	return sync;
}
