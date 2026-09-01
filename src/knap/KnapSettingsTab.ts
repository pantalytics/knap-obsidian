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

import { Notice, type Plugin, PluginSettingTab, Setting } from "obsidian";

import {
	OFFLINE,
	PROBLEM,
	SIGNED_OUT,
	SYNCING,
	syncCounts,
	syncInstruction,
	syncProgress,
} from "../syncStatus";
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
	/** The status block, while this screen is on the display. */
	private statusEl: HTMLElement | null = null;
	/** Whether the fold is out. Kept here so a repaint does not close it. */
	private open = false;
	/** The repaint, while this screen is on the display. */
	private ticking: number | null = null;

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
		// Every path below rebuilds the screen, and a tick left running would
		// go on painting into the block the rebuild threw away.
		this.stopTicking();
		this.statusEl = null;
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
	 * **It repaints itself once a second**, and on a phone that is the whole
	 * point of the screen. Obsidian has no status bar on mobile, so the corner
	 * of the window that carries the count and the bar on a desktop is not
	 * there at all, and this is the only place a person can watch a first fill
	 * happen. Drawn once, it froze on whatever was true the moment they opened
	 * Settings, which during a fill is the one moment worth nothing.
	 */
	private drawStatus(containerEl: HTMLElement): void {
		this.statusEl = containerEl.createDiv({ cls: "knap-status" });
		this.paintStatus();
		// The reading is a handful of numbers off objects this process already
		// holds: no request, no file, nothing to cache. A second is what the
		// corner of the window ticks at, and a bar that moves in different
		// steps in two places reads as two different measurements.
		this.ticking = window.setInterval(() => this.paintStatus(), 1000);
	}

	/** Stop repainting a screen nobody is looking at. */
	hide(): void {
		this.stopTicking();
	}

	private stopTicking(): void {
		if (this.ticking !== null) {
			window.clearInterval(this.ticking);
			this.ticking = null;
		}
	}

	/**
	 * The block, from scratch, for one reading.
	 *
	 * Rebuilt rather than patched element by element, because the facts behind
	 * the fold come and go with the word, and a paint that only updated the
	 * ones already there would leave the last word's facts under the new one.
	 * The fold's own state is the exception and lives on the tab, so a repaint
	 * does not shut it while somebody is reading it.
	 */
	private paintStatus(): void {
		const block = this.statusEl;
		if (!block) return;
		const status = this.sync.status();
		block.empty();

		const body = block.createDiv({ cls: "knap-status-body" });
		body.hidden = !this.open;

		const head = block.createEl("button", { cls: "knap-status-head" });
		head.type = "button";
		head.setAttribute("aria-expanded", String(this.open));
		head.createSpan({ cls: `knap-dot knap-dot-${status.dot}` });
		head.createSpan({ cls: "knap-status-word", text: status.word });
		const detail = detailLine(status);
		if (detail) {
			head.createSpan({ cls: "knap-status-detail", text: detail });
		}
		head.addEventListener("click", () => {
			this.open = !this.open;
			head.setAttribute("aria-expanded", String(this.open));
			body.hidden = !this.open;
		});
		// The head is written after the body so the click handler can close
		// over it, and moved above it here, where the reader expects it.
		block.insertBefore(head, body);

		// The bar under the head, and only while there is a pass for it to be
		// about. A track sitting empty over a caught-up vault is a job nobody
		// has started, which is the opposite of what it means, so it is absent
		// rather than empty the rest of the time.
		const progress = isMoving(status)
			? syncProgress(status.done, status.total)
			: undefined;
		if (progress !== undefined) {
			const track = block.createDiv({ cls: "knap-status-track" });
			// Nothing for a screen reader: the word and the count above it
			// already say this, and a second voice for one fact is one
			// interruption too many.
			track.setAttribute("aria-hidden", "true");
			const fill = track.createEl("i");
			// A whole number, because it goes straight into a width in percent
			// and a bar this thin has nothing below one percent to show.
			fill.setAttribute("style", `width: ${Math.round(progress * 100)}%`);
			block.insertBefore(track, body);
		}

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

/**
 * "Work notes · 290 of 2,567", or as much of it as is true.
 *
 * While a pass is running the count replaces the vault's size rather than
 * sitting beside it. Two numbers on one line is a person working out which
 * of them is going up, and the one that is moving is the one they came for.
 */
function detailLine(status: KnapStatus): string {
	const parts: string[] = [];
	if (status.vaultName) parts.push(status.vaultName);
	if (isMoving(status)) {
		parts.push(syncCounts(status.done, status.total));
	} else if (status.notes > 0) {
		parts.push(`${status.notes.toLocaleString("en-US")} note${status.notes === 1 ? "" : "s"}`);
	}
	return parts.join(" · ");
}

/**
 * Whether there is a bar to draw, which is the one thing the count and the
 * track have to agree about.
 */
export function isMoving(status: KnapStatus): boolean {
	return status.word === SYNCING && status.total > 0;
}

/** The address without its scheme, because nobody reads https to a person. */
function hostOf(serverUrl: string): string {
	try {
		return new URL(serverUrl).host;
	} catch {
		return serverUrl;
	}
}
