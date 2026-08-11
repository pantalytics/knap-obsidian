import { mount, unmount } from "svelte";
import { App, Modal } from "obsidian";
import EndpointConfigModalContent from "../components/EndpointConfigModalContent.svelte";
import type Live from "../main";

export class EndpointConfigModal extends Modal {
	private component?: Record<string, unknown>;

	constructor(
		app: App,
		private plugin: Live,
		private reload: () => void,
	) {
		super(app);
		this.setTitle("Enterprise tenant configuration");
	}

	onOpen() {
		const { contentEl } = this;

		this.component = mount(EndpointConfigModalContent, {
			target: contentEl,
			props: {
				plugin: this.plugin,
				reload: this.reload,
				onclose: () => {
					this.close();
				},
				onapply: () => {
					this.close();
					// Reload the plugin to apply changes
					window.setTimeout(() => {
						this.reload();
					}, 100);
				},
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (this.component) void unmount(this.component);
		this.component = undefined;
	}
}