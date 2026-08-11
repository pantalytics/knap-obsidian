import { mount, unmount } from "svelte";
import { App, Modal } from "obsidian";

// Svelte 5 components are functions, not classes, so this is the type mount()
// accepts rather than something with a `new` signature.
type SvelteComponent = Parameters<typeof mount>[0];

export class GenericSuggestModal<T> extends Modal {
	private component?: Record<string, unknown>;

	constructor(
		app: App,
		private ComponentClass: SvelteComponent,
		private componentProps: Record<string, unknown>,
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

		this.component = mount(this.ComponentClass, {
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
		if (this.component) void unmount(this.component);
		this.component = undefined;
	}

	destroy() {
		this.onSelect = null as unknown as (item: T) => void;
		this.componentProps = null as unknown as Record<string, unknown>;
		this.ComponentClass = null as unknown as SvelteComponent;
	}
}
