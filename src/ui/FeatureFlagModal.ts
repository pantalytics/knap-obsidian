import { mount, unmount } from "svelte";
import { App, Modal } from "obsidian";
import FeatureFlagModalContent from "../components/FeatureFlagModalContent.svelte";

export class FeatureFlagToggleModal extends Modal {
	private component?: Record<string, unknown>;

	constructor(
		app: App,
		private reload: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;

		this.component = mount(FeatureFlagModalContent, {
			target: contentEl,
			props: {
				reload: this.reload,
			},
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (this.component) void unmount(this.component);
	}
}
