"use strict";
import { TextFileView } from "obsidian";
import type { CanvasView } from "src/CanvasView";

export class Banner {
	view: TextFileView | CanvasView;
	text: string;
	onClick: () => Promise<boolean>;

	constructor(
		view: TextFileView | CanvasView,
		text: string,
		onClick: () => Promise<boolean>,
	) {
		this.view = view;
		this.text = text;
		this.onClick = onClick;
		this.display();
	}

	display() {
		if (!this.view) return true;
		const leafContentEl = this.view.containerEl;
		const contentEl = this.view.containerEl.querySelector(".view-content");

		if (!leafContentEl) {
			return;
		}

		// container to enable easy removal of the banner
		let bannerBox = leafContentEl.querySelector(".system3-banner-box") as HTMLElement | null;
		if (!bannerBox) {
			bannerBox = activeDocument.createElement("div") as HTMLElement;
			bannerBox.classList.add("system3-banner-box");
			leafContentEl.insertBefore(bannerBox, contentEl as Node | null);
			leafContentEl.classList.add("has-system3-banner");
		}

		let banner = leafContentEl.querySelector(".system3-banner") as HTMLElement | null;
		if (!banner) {
			banner = activeDocument.createElement("div") as HTMLElement;
			banner.classList.add("system3-banner");
			const span = banner.createSpan();
			span.setText(this.text);
			banner.appendChild(span);
			bannerBox.appendChild(banner);
			banner.addEventListener("click", () => {
				void this.onClick().then((destroy) => {
					if (destroy) {
						this.destroy();
					}
				});
			});
		}
		return true;
	}

	destroy() {
		const leafContentEl = this.view.containerEl;
		if (!leafContentEl) {
			return;
		}
		const bannerBox = leafContentEl.querySelector(".system3-banner-box");
		if (bannerBox) {
			bannerBox.replaceChildren();
			leafContentEl.classList.remove("has-system3-banner");
		}
		this.onClick = () => Promise.resolve(true);
		return true;
	}
}
