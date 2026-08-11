import { mount, unmount } from "svelte";
import { App, Modal } from "obsidian";
import DebugModalContent from "../components/DebugModalContent.svelte";
import type Live from "../main";

export class DebugModal extends Modal {
	private component?: Record<string, unknown>;

	constructor(
		app: App,
		private plugin: Live,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = mount(DebugModalContent, {
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
