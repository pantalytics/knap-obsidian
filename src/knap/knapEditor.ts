/**
 * The CodeMirror half: what an editor does with a live note and its cursors.
 *
 * Two jobs, one plugin, because both need the same thing and neither is
 * worth a second lookup: the note behind the file this editor is showing.
 * Typing goes into the document through `LiveNote`, and everybody else's
 * caret comes back out of awareness as decorations (`NoteCursors`).
 *
 * Nothing here imports Obsidian, and which file an editor is showing, the
 * one thing only Obsidian can answer, arrives as a function. So the whole
 * extension can be driven by a test with no screen. The caret's own markup
 * uses Obsidian's `createSpan` and `createDiv`, which is house style and
 * only runs when something is actually drawn.
 */

import { type EditorState, type Extension } from "@codemirror/state";
import {
	Decoration,
	EditorView,
	ViewPlugin,
	WidgetType,
	type DecorationSet,
	type PluginValue,
	type ViewUpdate,
} from "@codemirror/view";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

import { LiveNote, fromDocument } from "./LiveNote";
import { readCursors } from "./NoteCursors";

/** One note, live: its text, the awareness beside it, and how to let go. */
export interface LiveNoteHandle {
	text: Y.Text;
	awareness: Awareness;
	/** What this device calls itself, which is what a caret is labelled with. */
	deviceName: string;
	/** Hand the note back to the file binding. */
	release: () => void;
}

/** Where an editor's live note comes from. `KnapSync` is the one in Obsidian. */
export interface LiveNoteSource {
	/** The live note for a vault path, or null if this vault is not linked. */
	openNote(path: string): LiveNoteHandle | null;
}

/** A caret with a name on it, the way every collaborative editor draws one. */
class CaretWidget extends WidgetType {
	constructor(
		private readonly color: string,
		private readonly name: string,
	) {
		super();
	}

	eq(other: CaretWidget): boolean {
		return other.color === this.color && other.name === this.name;
	}

	toDOM(): HTMLElement {
		const caret = createSpan({ cls: "knap-caret" });
		caret.style.borderColor = this.color;
		caret.style.backgroundColor = this.color;
		const label = createDiv({ cls: "knap-caret-name", text: this.name });
		label.style.backgroundColor = this.color;
		caret.appendChild(label);
		return caret;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export const knapCursorTheme = EditorView.baseTheme({
	".knap-caret": {
		position: "relative",
		borderLeft: "1px solid",
		borderRight: "1px solid",
		marginLeft: "-1px",
		marginRight: "-1px",
		boxSizing: "border-box",
		display: "inline",
	},
	".knap-caret-name": {
		position: "absolute",
		top: "-1.15em",
		left: "-1px",
		fontSize: ".7em",
		lineHeight: "normal",
		color: "white",
		padding: "0 3px",
		borderRadius: "3px",
		whiteSpace: "nowrap",
		userSelect: "none",
		zIndex: "101",
		// Out of the way while somebody is reading, back on a mouseover.
		opacity: "0",
		transition: "opacity .2s ease-in-out",
	},
	".knap-caret:hover > .knap-caret-name": {
		opacity: "1",
	},
	".knap-selection": {
		borderRadius: "2px",
	},
});

/** Decorations for everybody else's selection and caret, in editor offsets. */
export function cursorDecorations(
	awareness: Awareness,
	text: Y.Text,
	length: number,
): DecorationSet {
	const decorations = [];
	for (const cursor of readCursors(awareness, text)) {
		if (cursor.to > length) continue; // this editor has not caught up yet
		if (cursor.from !== cursor.to) {
			decorations.push(
				Decoration.mark({
					class: "knap-selection",
					attributes: { style: `background-color: ${cursor.color}33` },
				}).range(cursor.from, cursor.to),
			);
		}
		decorations.push(
			Decoration.widget({
				widget: new CaretWidget(cursor.color, cursor.name),
				// The caret belongs outside the selection it trails.
				side: cursor.head > cursor.from ? 1 : -1,
			}).range(cursor.head),
		);
	}
	// Sorted, because CodeMirror takes its ranges in document order and
	// awareness hands them over in whatever order the states arrived.
	return Decoration.set(decorations, true);
}

class KnapEditorPlugin implements PluginValue {
	private note: LiveNoteHandle | null = null;
	private live: LiveNote | null = null;
	private path: string | null = null;
	private onAwareness: () => void;
	decorations: DecorationSet = Decoration.none;

	constructor(
		private readonly view: EditorView,
		private readonly source: LiveNoteSource,
		private readonly pathOf: (state: EditorState) => string | null,
	) {
		// An awareness change is not an editor change, so it needs a nudge to
		// get the decorations recomputed. An empty transaction is the nudge.
		this.onAwareness = () => this.view.dispatch({});
		this.bind();
	}

	private bind(): void {
		const path = this.pathOf(this.view.state);
		if (!path || path === this.path) return;
		this.unbind();
		const note = this.source.openNote(path);
		if (!note) return;
		this.path = path;
		this.note = note;
		this.live = new LiveNote(this.view, note.text, note.awareness, note.deviceName);
		note.awareness.on("change", this.onAwareness);
		this.refresh();
	}

	private unbind(): void {
		this.note?.awareness.off("change", this.onAwareness);
		this.live?.destroy();
		this.note?.release();
		this.live = null;
		this.note = null;
		this.path = null;
		this.decorations = Decoration.none;
	}

	update(update: ViewUpdate): void {
		// A note that is not in the cloud vault's tree yet has no document to
		// bind to, and a note opened in a tab that already existed has not
		// been asked for. Both settle on a later update rather than never.
		if (!this.live || this.pathOf(update.state) !== this.path) {
			this.bind();
			if (!this.live) return;
		}
		if (update.docChanged) {
			const mine = update.transactions.some((tr) => !tr.annotation(fromDocument));
			if (mine) this.live.pushChanges(update.changes);
		}
		this.live.publishSelection(update.state, update.view.hasFocus);
		this.refresh();
	}

	private refresh(): void {
		if (!this.note) return;
		this.decorations = cursorDecorations(
			this.note.awareness,
			this.note.text,
			this.view.state.doc.length,
		);
	}

	destroy(): void {
		this.unbind();
	}
}

/**
 * The extension to register with Obsidian: live editing and the cursors on it.
 */
export function knapLiveEditing(
	source: LiveNoteSource,
	pathOf: (state: EditorState) => string | null,
): Extension[] {
	return [
		knapCursorTheme,
		ViewPlugin.define((view) => new KnapEditorPlugin(view, source, pathOf), {
			decorations: (plugin) => plugin.decorations,
		}),
	];
}
