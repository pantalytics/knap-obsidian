"use strict";

import { mount, unmount } from "svelte";
import { writable, type Writable } from "svelte/store";
import { App, PluginSettingTab } from "obsidian";
import Live from "src/main";
import PluginSettings from "src/components/PluginSettings.svelte";

export class LiveSettingsTab extends PluginSettingTab {
	plugin: Live;
	component?: Record<string, unknown>;
	targetEl!: HTMLElement;
	// navigateTo used to call component.$set, which Svelte 5 removed. Props
	// handed to mount() are only reactive when the props object is $state, and
	// runes are not available in a plain .ts file, so the path travels as a
	// store the component subscribes to.
	private readonly path: Writable<string | undefined> = writable(undefined);

	constructor(app: App, plugin: Live) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const { containerEl } = this;
		this.targetEl = containerEl.parentElement as HTMLElement;
		this.targetEl.empty();
		void this.plugin.relayManager.update();
		this.component = mount(PluginSettings, {
			target: this.targetEl,
			props: {
				plugin: this.plugin,
				path: this.path,
				close: () => {
					(this as unknown as { setting: { close: () => void } }).setting.close();
				},
			},
		});
	}

	navigateTo(path: string) {
		this.path.set(path);
	}

	hide(): void {
		try {
			if (this.component) void unmount(this.component);
			this.component = undefined;
			// The tab is rebuilt by display() on reopen, so the path must not
			// survive: a stale value would re-navigate on the next open.
			this.path.set(undefined);
		} catch (e: unknown) {
			console.warn(e);
		}
	}

	destroy() {
		this.hide();
		this.plugin = null as unknown as Live;
	}
}
