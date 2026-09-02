/**
 * What linking looks like while it happens.
 *
 * Pressing a vault in the picker used to do this: the picker closed, the
 * screen behind it sat unchanged, and somewhere between one second and four
 * minutes later a notice said *Linked*. The wait is the reconciliation, and
 * it is honest work, but nothing on screen said so, so the only reading
 * available to a person was that the button had not done anything.
 *
 * This is the same act with its steps out. Eight rows, each going from
 * waiting to running to a number, and the two that matter are near the end:
 * what has to come down, and what has to go up. Those two are the answer to
 * how long the next part is going to take.
 *
 * **It closes itself on the last step**, because the modal is about the link
 * and the link is made by then. What happens after it is the first sync, and
 * the bar on the screen behind has a word for that (Initializing) and a
 * sentence under it saying to leave Obsidian open. Holding a modal open over
 * a job that takes minutes would be a second place saying the same thing, and
 * a person cannot use their vault behind it.
 *
 * The drawing is deliberately thin. Which steps there are, what they are
 * called and what each of them shows is `linkSteps.ts`, which is pure and
 * tested; this file turns rows into elements and knows nothing else.
 */

import { Modal, setIcon, type App } from "obsidian";

import type { LinkFacts, LinkRow, LinkStep } from "./linkSteps";
import { BOTH_WAYS, linkRows } from "./linkSteps";

/** How long the finished list stays up, so the last line can be read. */
const CLOSE_AFTER_MS = 900;

export class LinkProgressModal extends Modal {
	private rowsEl: HTMLElement | null = null;
	private noteEl: HTMLElement | null = null;
	private done: LinkStep | null = null;
	private facts: LinkFacts = {};
	private failed = false;
	private closing: number | null = null;

	constructor(
		app: App,
		private readonly vaultName: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("knap-link");
		contentEl.createEl("h2", { text: `Linking to ${this.vaultName}` });
		// What the link means from here on, on the screen that makes it.
		contentEl.createDiv({ cls: "knap-link-say", text: BOTH_WAYS });
		this.rowsEl = contentEl.createDiv({ cls: "knap-link-steps" });
		this.noteEl = contentEl.createDiv({ cls: "knap-link-note" });
		this.paint();
	}

	onClose(): void {
		if (this.closing !== null) window.clearTimeout(this.closing);
		this.closing = null;
		this.rowsEl = null;
		this.noteEl = null;
		this.contentEl.empty();
	}

	/** One step finished. The last one closes the modal after a beat. */
	step(step: LinkStep, facts: LinkFacts): void {
		this.done = step;
		this.facts = { ...facts };
		this.paint();
		if (step === "linked" && this.closing === null) {
			this.closing = window.setTimeout(() => this.close(), CLOSE_AFTER_MS);
		}
	}

	/**
	 * It did not work. The list stays where it stopped, with the step that
	 * failed marked, and the sentence goes under it: a modal that vanished
	 * would leave the failure to a notice in the corner, over a screen that
	 * still says Not linked and does not say why.
	 */
	fail(message: string): void {
		this.failed = true;
		this.paint(message);
	}

	private paint(problem = ""): void {
		const rows = this.rowsEl;
		if (!rows) return;
		rows.empty();
		for (const row of linkRows(this.done, this.facts, this.failed)) {
			this.drawRow(rows, row);
		}
		const note = this.noteEl;
		if (!note) return;
		note.empty();
		if (problem) {
			note.createDiv({ cls: "knap-link-problem", text: problem });
			note.createDiv({
				cls: "knap-link-say",
				text: "Nothing was changed. Your notes are all still on this device.",
			});
		}
	}

	private drawRow(parent: HTMLElement, row: LinkRow): void {
		const el = parent.createDiv({ cls: `knap-link-step knap-link-${row.state}` });
		const mark = el.createSpan({ cls: "knap-link-mark" });
		// Three marks and one blank. A waiting step gets nothing rather than
		// an empty circle, because eight circles at once reads as eight
		// things going wrong.
		if (row.state === "done") setIcon(mark as HTMLElement, "check");
		if (row.state === "doing") setIcon(mark as HTMLElement, "loader");
		if (row.state === "failed") setIcon(mark as HTMLElement, "x");
		el.createSpan({ cls: "knap-link-label", text: row.label });
		el.createSpan({ cls: "knap-link-value", text: row.value });
	}
}
