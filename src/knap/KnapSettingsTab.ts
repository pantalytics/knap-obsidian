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
 * The bar waits for a link, because how it is going is a question about a
 * cloud vault and there is not one yet.
 * That last row keeps one sentence the shortening did not touch, because a
 * delete travels both ways and somebody is entitled to know that before they
 * press it rather than after (#116).
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

import { Notice, type Plugin, PluginSettingTab, Setting, setIcon } from "obsidian";

import { OFFLINE, PROBLEM, syncInstruction } from "../syncStatus";
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
 *
 * **The vault and its note count are not here**, because the head already
 * carries them and the fold's whole justification is holding what the head
 * does not. They were in both until #125, which is how one phone screen came
 * to say the vault's name three times: in the head, behind the fold, and again
 * on the Cloud vault row. On a desktop width those three sit far apart and the
 * repetition is quiet. Stacked into one column on a phone they are within a
 * thumb of each other.
 */
export function statusFacts(status: KnapStatus): Array<[string, string]> {
	const facts: Array<[string, string]> = [];
	// The corner has room for two numbers and adds the two kinds of file
	// together to get them. This is the screen with room to keep them apart,
	// and attachments are worth keeping apart: one photo is a hundred notes'
	// worth of bytes, so a single number sits still and then jumps (ADR-0088).
	// The rows are named the way the tooltip says it, because somebody moves
	// between the two in one sitting.
	//
	// These are not the repetition #125 took out. The head carries the vault
	// and how many notes are in it; how many are still moving is a different
	// fact and is nowhere else on the screen.
	const going = pieces(status.up, status.files.up);
	if (going) facts.push(["To the cloud vault", going]);
	const coming = pieces(status.down, status.files.down);
	if (coming) facts.push(["To this device", coming]);
	if (status.problems > 0) {
		facts.push([
			"Could not sync",
			`${status.problems} change${status.problems === 1 ? "" : "s"}`,
		]);
	}
	return facts;
}

/** "412 notes, 3 attachments", or as much of it as is above zero. */
function pieces(notes: number, files: number): string {
	const parts: string[] = [];
	if (notes > 0) parts.push(`${count(notes)} note${notes === 1 ? "" : "s"}`);
	if (files > 0) parts.push(`${count(files)} attachment${files === 1 ? "" : "s"}`);
	return parts.join(", ");
}

function count(n: number): string {
	return n.toLocaleString("en-US");
}

/**
 * Whether the bar has anything folded away at all.
 *
 * On the happy path it does not: no instruction under *Up to date*, nothing
 * stuck, nothing to retry. A head that opens onto an empty strip is worse than
 * a head that does not open, so the bar only becomes a button when there is
 * something under it.
 */
export function hasFold(status: KnapStatus): boolean {
	return Boolean(syncInstruction(status.word)) || statusFacts(status).length > 0 || hasRetry(status);
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

		const linked = this.sync.linked;

		// The bar only appears once there is a link. Before that it has no
		// vault to be about, and the words are all wrong for it: nothing is
		// syncing, so it settled on Up to date, over a vault that was going
		// nowhere. That is #40's lie in a new place, and the row underneath
		// already says Not linked, which is both truer and the way out.
		if (linked) this.drawStatus(containerEl);

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

		const vault = new Setting(containerEl)
			.setName("Cloud vault")
			.setDesc(
				linked
					? `${linked.cloudVaultName}. Deleting a note here deletes it in the ` +
						"cloud vault too, and the other way round."
					: "Not linked.",
			);

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
	 *
	 * **The head is a button only when something is folded behind it** (#125).
	 * Under *Up to date* there is no instruction, nothing stuck and nothing to
	 * retry, so the head opens onto an empty strip, and a control that does
	 * nothing is worse than no control.
	 *
	 * The detail is two spans rather than one string because they shrink
	 * differently. On a phone the whole line is wider than the card, and the
	 * count is the half worth keeping: a long vault name is a name, while
	 * *1,368 notes* is the answer to what somebody opened the screen for. So the
	 * name truncates and the count never does.
	 */
	private drawStatus(containerEl: HTMLElement): void {
		const status = this.sync.status();
		const block = containerEl.createDiv({ cls: "knap-status" });
		const folds = hasFold(status);

		const body = block.createDiv({ cls: "knap-status-body" });
		body.hidden = true;

		const head = folds
			? block.createEl("button", { cls: "knap-status-head knap-status-opens" })
			: block.createDiv({ cls: "knap-status-head" });
		if (folds) (head as HTMLButtonElement).type = "button";
		head.createSpan({ cls: `knap-dot knap-dot-${status.dot}` });
		head.createSpan({ cls: "knap-status-word", text: status.word });
		const detail = head.createSpan({ cls: "knap-status-detail" });
		if (status.vaultName) {
			detail.createSpan({ cls: "knap-status-vault", text: status.vaultName });
		}
		if (status.notes > 0) {
			detail.createSpan({
				cls: "knap-status-count",
				text: `${status.notes.toLocaleString("en-US")} note${status.notes === 1 ? "" : "s"}`,
			});
		}

		if (folds) {
			// A touch screen has no hover to discover the fold with, so the
			// chevron is the only thing that says the bar opens (#125).
			const chevron = head.createSpan({ cls: "knap-status-chevron" });
			setIcon(chevron as HTMLElement, "chevron-down");
			head.setAttribute("aria-expanded", "false");
			head.addEventListener("click", () => {
				const open = head.getAttribute("aria-expanded") === "true";
				head.setAttribute("aria-expanded", String(!open));
				body.hidden = open;
			});
		}
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
	}
}

/** The address without its scheme, because nobody reads https to a person. */
function hostOf(serverUrl: string): string {
	try {
		return new URL(serverUrl).host;
	} catch {
		return serverUrl;
	}
}
