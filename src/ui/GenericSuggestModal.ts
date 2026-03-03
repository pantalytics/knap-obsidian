import { App, Modal } from "obsidian";

export class GenericSuggestModal<T> extends Modal {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private component?: any;

	constructor(
		app: App,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		private ComponentClass: any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		private componentProps: any,
		private onSelect: (item: T) => void,
	) {
		super(app);
	}

	onOpen() {
		const { modalEl } = this;

		// Find the modal container and hide the modal wrapper
		const modalContainer = modalEl.closest(".modal-container");
		modalEl.addClass("evc-hidden");
		const contentEl = modalContainer || modalEl;

		this.component = new this.ComponentClass({
			target: contentEl,
			props: {
				...this.componentProps,
				autofocus: true,
				onSelect: (item: T) => {
					this.onSelect(item);
					this.close();
				},
			},
		});
	}

	onClose() {
		this.component?.$destroy();
	}

	destroy() {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.onSelect = null as any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.componentProps = null as any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		this.ComponentClass = null as any;
	}
}
