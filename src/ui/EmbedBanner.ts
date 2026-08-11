"use strict";

export class EmbedBanner {
	text: string;
	onClick: () => Promise<boolean>;

	constructor(
		private containerEl: Element | null,
		private before: Element | null,
		text: string,
		onClick: () => Promise<boolean>,
	) {
		this.text = text;
		this.onClick = onClick;
		this.display();
	}

	display() {
		if (!this.containerEl || !this.before) return true;
		const leafContentEl = this.containerEl;
		const contentEl = this.before;

		if (!leafContentEl) {
			return;
		}

		// container to enable easy removal of the banner
		let bannerBox = leafContentEl.querySelector(".system3-banner-box");
		if (!bannerBox) {
			bannerBox = createDiv();
			bannerBox.classList.add("system3-banner-box");
			leafContentEl.insertBefore(bannerBox, contentEl);
			leafContentEl.classList.add("has-system3-banner");
		}

		let banner = leafContentEl.querySelector(".system3-banner");
		if (!banner) {
			banner = createDiv();
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
		const leafContentEl = this.containerEl;
		if (!leafContentEl) {
			return;
		}
		const bannerBox = leafContentEl.querySelector(".system3-banner-box");
		if (bannerBox) {
			bannerBox.replaceChildren();
			leafContentEl.classList.remove("has-system3-banner");
		}
		return true;
	}
}
