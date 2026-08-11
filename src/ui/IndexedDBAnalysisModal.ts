import { mount, unmount } from "svelte";
import { App, Modal } from "obsidian";
import IndexedDBAnalysisModalContent from "../components/IndexedDBAnalysisModalContent.svelte";
import type Live from "../main";

export class IndexedDBAnalysisModal extends Modal {
	private component?: Record<string, unknown>;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = mount(IndexedDBAnalysisModalContent, {
			target: contentEl,
			props: {
				plugin: this.plugin,
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (this.component) void unmount(this.component);
	}
}
