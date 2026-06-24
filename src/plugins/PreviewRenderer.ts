import { MarkdownView } from "obsidian";
import { Document } from "../Document";
import type { ViewRenderer } from "./ViewRenderer";
import { flags } from "../flagManager";
import { HasLogging } from "../debug";

/**
 * Pure UI rendering logic for preview mode synchronization.
 * Updates preview UI when document changes occur.
 */
export class PreviewRenderer extends HasLogging implements ViewRenderer {
	private view: MarkdownView;
	private destroyed = false;

	constructor(view: MarkdownView) {
		super();
		this.view = view;
		this.setLoggers(`[PreviewRenderer][${view.file?.path}]`);
		this.debug("created");
	}

	render(doc: Document, viewMode: string): void {
		if (this.destroyed) {
			this.debug("Skipping render - renderer destroyed");
			return;
		}

		if (!flags().enablePreviewViewHooks) {
			this.debug("Preview view hooks disabled via flags");
			return;
		}

		if (viewMode !== "preview") {
			this.debug("Skipping render - not in preview mode");
			return;
		}

		try {
			this.debug("Rendering preview from document");

			type ObsidianMarkdownViewInternal = {
				text?: string;
				previewMode?: { renderer?: { set: (text: string) => void } };
				onInternalDataChange?: () => void;
			};
			const internalView = this.view as unknown as ObsidianMarkdownViewInternal;

			// Update the view's internal text state
			internalView.text = doc.text;

			// Update the preview renderer
			internalView.previewMode?.renderer?.set(doc.text);

			// Trigger internal data change handler if available
			internalView.onInternalDataChange?.();

			this.debug("Preview render completed");
		} catch (error: unknown) {
			this.error("Error rendering preview:", error);
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.debug("destroyed");
		this.view = null as unknown as MarkdownView;
	}
}