/**
 * The one screen the rebuilt client has: sign in, link, unlink, sign out.
 *
 * It exists because the three commands were the only way in, and a command
 * palette is where somebody looks after they already know the thing is there.
 * Asked to try the beta, the first thing a person does is open Settings and
 * look for a button -- and in a beta build the relay's own tab is hidden, so
 * they found nothing at all.
 *
 * Three lines and at most three buttons, because there are only ever three
 * states: signed out, signed in but not linked, and linked. No server field
 * (ADR-0033): which server this build talks to is baked in, and the screen
 * says which one rather than offering a choice.
 *
 * Signed in, there is always a way back out. A screen that can only sign in
 * is one a person cannot hand their laptop on from, and the only alternative
 * was uninstalling the plugin -- which leaves the token alive anyway.
 */

import { Notice, type Plugin, PluginSettingTab, Setting } from "obsidian";

import type { CloudVault } from "./KnapServer";
import type { KnapSync } from "./KnapSync";

/**
 * What to say after a sign-out. One sentence, two entry points: this button
 * and the command in the palette, which must not drift apart into two
 * accounts of the same act.
 */
export function signOutNotice(endedRemotely: boolean): string {
	return endedRemotely
		? "Signed out. Nothing was deleted, anywhere."
		: "Signed out on this device. Knap could not be reached, so this device may still " +
				"count as signed in there.";
}

/** The two acts the buttons perform, so the screen shares them with the commands. */
export interface SignInActions {
	/** Starts the browser half and resolves when the deep link comes back. */
	signIn(): Promise<void>;
	/** Offers the account's cloud vaults and links the one that is picked. */
	pickAndLink(): Promise<void>;
}

export class KnapSettingsTab extends PluginSettingTab {
	/**
	 * ``plugin`` is the real plugin, not a stand-in. Obsidian registers the tab
	 * against it, and handing it an object that merely looks like one threw
	 * during onload -- which took everything registered after that call with
	 * it, the ribbon icon included.
	 */
	constructor(
		plugin: Plugin,
		private readonly sync: KnapSync,
		private readonly actions: SignInActions,
		private readonly serverUrl: string,
	) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const linked: CloudVault | null = this.sync.linked
			? { id: this.sync.linked.cloudVaultId, name: this.sync.linked.cloudVaultName }
			: null;

		if (!this.sync.signedIn) {
			new Setting(containerEl)
				.setName("Sign in")
				.setDesc(
					"Opens your browser. Sign in there and it comes back here. " +
						`This build talks to ${this.serverUrl}.`,
				)
				.addButton((button) =>
					button
						.setButtonText("Sign in")
						.setCta()
						.onClick(() => {
							void this.actions
								.signIn()
								.then(() => {
									new Notice("Signed in. Now link this vault to a cloud vault.");
									this.display();
								})
								.catch((error: Error) => new Notice(error.message));
						}),
				);
			return;
		}

		new Setting(containerEl)
			.setName("This vault")
			.setDesc(
				linked?.name
					? `Syncs with the cloud vault ${linked.name}.`
					: "Signed in, and not linked to a cloud vault yet.",
			)
			.addButton((button) =>
				button
					.setButtonText(linked ? "Link a different one" : "Link a cloud vault")
					.setCta()
					.onClick(() => {
						void this.actions
							.pickAndLink()
							.then(() => this.display())
							.catch((error: Error) => new Notice(error.message));
					}),
			);

		if (linked) {
			new Setting(containerEl)
				.setName("Unlink")
				.setDesc(
					"Stops the syncing. Nothing is deleted, here or in the cloud vault, " +
						"and linking again picks up where this left off.",
				)
				.addButton((button) =>
					button.setButtonText("Unlink").onClick(() => {
						void this.sync.unlink().then(() => {
							new Notice("Unlinked. Nothing was deleted, anywhere.");
							this.display();
						});
					}),
				);
		}

		new Setting(containerEl)
			.setName("Sign out")
			.setDesc(
				"Ends the sign-in on this device and stops the syncing. Your notes stay " +
					"where they are, here and in the cloud vault.",
			)
			.addButton((button) =>
				button.setButtonText("Sign out").onClick(() => {
					void this.sync.signOut().then(({ endedRemotely }) => {
						new Notice(signOutNotice(endedRemotely));
						this.display();
					});
				}),
			);
	}
}
