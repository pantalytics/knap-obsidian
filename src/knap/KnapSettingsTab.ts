/**
 * The one screen the rebuilt client has: a status bar, an account and a link.
 *
 * It exists because the commands were the only way in, and a command palette
 * is where somebody looks after they already know the thing is there. Asked to
 * try the beta, the first thing a person does is open Settings and look for a
 * button, and in a beta build the relay's own tab is hidden, so they found
 * nothing at all.
 *
 * **Two rows and a bar, and each of the three earns its place**: the bar says
 * how it is going, Account is who, Cloud vault is what this vault syncs with.
 * There is no server field (ADR-0033), no scope picker (ADR-0043), and no
 * second kind of member to set (ADR-0034). There is also no Change button:
 * linking somewhere else is Unlink and then Choose, which is what happens
 * underneath either way, and a third button to say so is a third button.
 *
 * The bar is the only thing on the screen that folds. That is the hierarchy:
 * the dot and the word are always out, the vault and its size sit beside them,
 * and the handful of facts behind them come out when somebody asks. Nothing
 * deeper is kept here at all. What went wrong in detail is on the server, and
 * the device only ever tells it four content-free facts (ADR-0071).
 *
 * Signed in, there is always a way back out. A screen that can only sign in is
 * one a person cannot hand their laptop on from, and the only alternative was
 * uninstalling the plugin, which leaves the token alive anyway.
 */

import { Notice, type Plugin, PluginSettingTab, Setting } from "obsidian";

import { OFFLINE, PROBLEM, SIGNED_OUT, syncInstruction } from "../syncStatus";
import type { KnapStatus, KnapSync } from "./KnapSync";

/**
 * What to say after a sign-out. One sentence, two entry points: this button
 * and the command in the palette, which must not drift apart into two
 * accounts of the same act.
 */
export function signOutNotice(endedRemotely: boolean): string {
	return endedRemotely
		? "Signed out. Nothing was deleted, anywhere."
		: "Signed out here only. Knap could not be reached, so it may still count this device as signed in.";
}

/**
 * The facts behind the fold, for one reading.
 *
 * Pure, and exported, because it is the half of the bar worth pinning in a
 * test: which facts appear depends on the word, and a fact that appears with
 * nothing to say is the sort of empty row this screen exists to be rid of.
 */
export function statusFacts(status: KnapStatus): Array<[string, string]> {
	const facts: Array<[string, string]> = [];
	if (status.vaultName) {
		facts.push(["Cloud vault", status.vaultName]);
	}
	if (status.notes > 0) {
		facts.push(["Notes", status.notes.toLocaleString("en-US")]);
	}
	if (status.problems > 0) {
		facts.push([
			"Could not sync",
			`${status.problems} change${status.problems === 1 ? "" : "s"}`,
		]);
	}
	return facts;
}

/** Only the two words a person can do something about get a button here. */
export function hasRetry(status: KnapStatus): boolean {
	return status.word === PROBLEM || status.word === OFFLINE;
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
	 * during onload, which took everything registered after that call with it,
	 * the ribbon icon included.
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

		// The server, once, quietly, where a plugin's own subtitle goes. It
		// belongs on the screen because a beta build talks to somewhere other
		// than the release does, and nowhere near a button, because it is not
		// a choice (ADR-0033).
		containerEl.createDiv({ cls: "knap-server", text: hostOf(this.serverUrl) });

		if (!this.sync.signedIn) {
			new Setting(containerEl)
				.setName("Account")
				.setDesc("Not signed in. Signing in opens your browser and comes back here.")
				.addButton((button) =>
					button
						.setButtonText("Sign in")
						.setCta()
						.onClick(() => {
							void this.actions
								.signIn()
								.then(() => {
									new Notice("Signed in. Now link this vault.");
									this.display();
								})
								.catch((error: Error) => new Notice(error.message));
						}),
				);
			return;
		}

		this.drawStatus(containerEl);

		new Setting(containerEl)
			.setName("Account")
			.setDesc("Signed in.")
			.addButton((button) =>
				button.setButtonText("Sign out").onClick(() => {
					void this.sync.signOut().then(({ endedRemotely }) => {
						new Notice(signOutNotice(endedRemotely));
						this.display();
					});
				}),
			);

		const linked = this.sync.linked;
		const vault = new Setting(containerEl)
			.setName("Cloud vault")
			.setDesc(linked?.cloudVaultName || "Not linked.");

		if (linked) {
			vault.addButton((button) =>
				button.setButtonText("Unlink").onClick(() => {
					void this.sync.unlink().then(() => {
						new Notice("Unlinked. Nothing was deleted, anywhere.");
						this.display();
					});
				}),
			);
			return;
		}

		vault.addButton((button) =>
			button
				.setButtonText("Choose...")
				.setCta()
				.onClick(() => {
					void this.actions
						.pickAndLink()
						.then(() => this.display())
						.catch((error: Error) => new Notice(error.message));
				}),
		);
	}

	/**
	 * The bar: a dot, a word, and what it is about, with the rest folded away.
	 *
	 * Drawn by hand rather than as a Setting because a Setting is a name, a
	 * description and controls on the right, and this is none of those. It is
	 * the first thing on the screen because it is what somebody came to find
	 * out; the two rows under it are what they came to change, which is rarer.
	 */
	private drawStatus(containerEl: HTMLElement): void {
		const status = this.sync.status();
		const block = containerEl.createDiv({ cls: "knap-status" });

		const body = block.createDiv({ cls: "knap-status-body" });
		body.hidden = true;

		const head = block.createEl("button", { cls: "knap-status-head" });
		head.type = "button";
		head.setAttribute("aria-expanded", "false");
		head.createSpan({ cls: `knap-dot knap-dot-${status.dot}` });
		head.createSpan({ cls: "knap-status-word", text: status.word });
		const detail = detailLine(status);
		if (detail) {
			head.createSpan({ cls: "knap-status-detail", text: detail });
		}
		head.addEventListener("click", () => {
			const open = head.getAttribute("aria-expanded") === "true";
			head.setAttribute("aria-expanded", String(!open));
			body.hidden = open;
		});
		// The head is written after the body so the click handler can close
		// over it, and moved above it here, where the reader expects it.
		block.insertBefore(head, body);

		const instruction = syncInstruction(status.word);
		if (instruction) {
			body.createDiv({ cls: "knap-status-say", text: instruction });
		}
		for (const [key, value] of statusFacts(status)) {
			const row = body.createDiv({ cls: "knap-status-fact" });
			row.createSpan({ cls: "knap-status-key", text: key });
			row.createSpan({ cls: "knap-status-value", text: value });
		}
		if (hasRetry(status)) {
			const retry = body.createEl("button", { cls: "knap-status-retry", text: "Try again" });
			retry.type = "button";
			retry.addEventListener("click", () => {
				void this.sync.retry().then(() => this.display());
			});
		}
		if (status.word === SIGNED_OUT) {
			// Unreachable from here, because a signed-out screen never draws
			// the bar. Kept as the one place that would have to change if the
			// bar ever appeared before the account did.
			body.createDiv({ cls: "knap-status-say", text: "Sign in above to carry on." });
		}
	}
}

/** "Work notes, 312 notes", or as much of it as is true. */
function detailLine(status: KnapStatus): string {
	const parts: string[] = [];
	if (status.vaultName) parts.push(status.vaultName);
	if (status.notes > 0) {
		parts.push(`${status.notes.toLocaleString("en-US")} note${status.notes === 1 ? "" : "s"}`);
	}
	return parts.join(" · ");
}

/** The address without its scheme, because nobody reads https to a person. */
function hostOf(serverUrl: string): string {
	try {
		return new URL(serverUrl).host;
	} catch {
		return serverUrl;
	}
}
