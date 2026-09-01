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
	/** The plugin. The tick below is its to own, so an unload takes it. */
	private readonly owner: Plugin;
	/** Where the bar is drawn, so a tick can redraw it and nothing else. */
	private statusEl: HTMLElement | null = null;
	/** Whether the fold is open. A field, so a redraw does not close it. */
	private open = false;
	/** What the bar last said, so a tick that changes nothing draws nothing. */
	private said = "";
	/** Set while a retry is in flight, so the button can say it is going. */
	private trying = false;
	/** The tick, while this screen is on. */
	private ticker: number | null = null;

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
		this.owner = plugin;
	}

	/** The screen is closed: the tick stops with it. */
	hide(): void {
		this.stopTick();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		// Redrawn from scratch, so whatever the bar was drawn into has gone
		// and the tick has nothing to paint until this pass makes a new slot.
		this.stopTick();
		this.statusEl = null;
		this.said = "";

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
		if (linked) {
			this.statusEl = containerEl.createDiv({ cls: "knap-status-slot" });
			this.paint();
			this.startTick();
		}

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
	 * The tick, at a second, which is what the corner of the window ticks at.
	 *
	 * The bar is a reading and not an event: the socket comes up and goes down
	 * without telling anybody, and a screen drawn once when Settings opened
	 * went on saying whatever was true at that instant. Somebody who opened
	 * this screen while the link was still connecting was told *Offline* over
	 * a vault that had been syncing for a minute, and the only way out of it
	 * was to close Settings and come back.
	 */
	private startTick(): void {
		if (this.ticker !== null) return;
		const timer = window.setInterval(() => this.paint(), 1000);
		this.ticker = timer;
		// The plugin owns it, so an unload with Settings open takes it too.
		this.owner.registerInterval(timer);
	}

	private stopTick(): void {
		if (this.ticker === null) return;
		window.clearInterval(this.ticker);
		this.ticker = null;
	}

	/**
	 * Draw the bar, if what it has to say has changed since the last pass.
	 *
	 * Gated on the words rather than drawn every second, for two reasons. A
	 * redraw between a mouse going down and coming up eats the click on the
	 * button underneath, which is the one control this bar has. And the fold
	 * is a person's decision, so it is held here rather than in the DOM the
	 * redraw throws away.
	 */
	paint(): void {
		const slot = this.statusEl;
		if (!slot) return;
		const status = this.sync.status();
		const said = JSON.stringify([status, this.trying]);
		if (said === this.said) return;
		this.said = said;
		slot.empty();
		this.drawStatus(slot, status);
	}

	/**
	 * The button under Problem and Offline, and what it owes whoever pressed
	 * it.
	 *
	 * A retry takes as long as the tree takes to sync, which is up to half a
	 * minute before it gives up. Until this it said nothing for that whole
	 * time and then swallowed the failure, so the one control on the bar
	 * behaved exactly like a button that does nothing: press it, watch the
	 * fold snap shut, read *Offline* again. It says it is going while it
	 * goes, and says what went wrong when it does.
	 */
	private tryAgain(): void {
		if (this.trying) return;
		this.trying = true;
		this.paint();
		void this.sync.retry().then(
			() => {
				this.trying = false;
				// Nothing is asserted here about how it went. A socket is not
				// up the instant start() returns, and the tick says what is
				// true a second later rather than this saying it early.
				this.paint();
			},
			(error: Error) => {
				this.trying = false;
				new Notice(error.message);
				this.paint();
			},
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
	private drawStatus(containerEl: HTMLElement, status: KnapStatus): void {
		const block = containerEl.createDiv({ cls: "knap-status" });
		const folds = hasFold(status);
		// A fold that is no longer there is not a fold somebody left open.
		if (!folds) this.open = false;

		const body = block.createDiv({ cls: "knap-status-body" });
		body.hidden = !this.open;

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
			head.setAttribute("aria-expanded", String(this.open));
			head.addEventListener("click", () => {
				this.open = !this.open;
				head.setAttribute("aria-expanded", String(this.open));
				body.hidden = !this.open;
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
			const retry = body.createEl("button", {
				cls: "knap-status-retry",
				text: this.trying ? "Trying..." : "Try again",
			});
			retry.type = "button";
			retry.disabled = this.trying;
			retry.addEventListener("click", () => this.tryAgain());
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
