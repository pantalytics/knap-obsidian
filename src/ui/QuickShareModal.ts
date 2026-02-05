/**
 * Quick Share Modal
 *
 * Modal for quickly sharing a folder from context menu in relay-onprem mode.
 * Handles server selection if logged into multiple servers.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type Live from "../main";
import type { RelayOnPremServer } from "../RelayOnPremConfig";
import { getServerById } from "../RelayOnPremConfig";

export class QuickShareModal extends Modal {
	private selectedServerId: string | undefined;
	private isCreating = false;

	constructor(
		app: App,
		private plugin: Live,
		private folderPath: string,
	) {
		super(app);
		this.setTitle("Share Folder");
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("relay-quick-share-modal");

		// Get logged-in servers
		const loggedInServerIds = this.plugin.loginManager.getLoggedInServers();
		const settings = this.plugin.relayOnPremSettings.get();

		if (loggedInServerIds.length === 0) {
			contentEl.createEl("p", {
				text: "Please log in to a server first.",
				cls: "relay-quick-share-error",
			});
			return;
		}

		// Get server objects for logged-in servers
		const loggedInServers = loggedInServerIds
			.map(id => getServerById(settings, id))
			.filter((s): s is RelayOnPremServer => s !== undefined);

		// Set default selection
		if (settings.defaultServerId && loggedInServerIds.includes(settings.defaultServerId)) {
			this.selectedServerId = settings.defaultServerId;
		} else if (loggedInServerIds.length > 0) {
			this.selectedServerId = loggedInServerIds[0];
		}

		// Folder path display
		new Setting(contentEl)
			.setName("Folder")
			.setDesc(this.folderPath);

		// Server selector (only if multiple servers)
		if (loggedInServers.length > 1) {
			new Setting(contentEl)
				.setName("Server")
				.setDesc("Select which server to create the share on")
				.addDropdown((dropdown) => {
					loggedInServers.forEach((server) => {
						dropdown.addOption(server.id, server.name);
					});
					if (this.selectedServerId) {
						dropdown.setValue(this.selectedServerId);
					}
					dropdown.onChange((value) => {
						this.selectedServerId = value;
					});
				});
		} else if (loggedInServers.length === 1) {
			// Show which server will be used (read-only)
			new Setting(contentEl)
				.setName("Server")
				.setDesc(loggedInServers[0].name);
		}

		// Create button
		const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
		buttonContainer.style.marginTop = "20px";
		buttonContainer.style.display = "flex";
		buttonContainer.style.justifyContent = "flex-end";
		buttonContainer.style.gap = "10px";

		const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const createBtn = buttonContainer.createEl("button", {
			text: "Create Share",
			cls: "mod-cta",
		});
		createBtn.addEventListener("click", () => this.createShare());
	}

	private async createShare() {
		if (!this.selectedServerId || this.isCreating) {
			return;
		}

		this.isCreating = true;
		const settings = this.plugin.relayOnPremSettings.get();
		const server = getServerById(settings, this.selectedServerId);

		if (!server) {
			new Notice("Server not found");
			this.isCreating = false;
			return;
		}

		try {
			// Create share on the server
			if (!this.plugin.shareClientManager) {
				throw new Error("Share client not initialized");
			}

			const share = await this.plugin.shareClientManager.createShare(
				this.selectedServerId,
				{
					kind: "folder",
					path: this.folderPath,
					visibility: "private",
				}
			);

			// Create local SharedFolder
			const sharedFolder = this.plugin.sharedFolders.new(
				this.folderPath,
				share.id,
				undefined,
				false
			);

			// Store server ID in settings
			if (sharedFolder && sharedFolder.settings) {
				sharedFolder.settings.onpremServerId = this.selectedServerId;
			}

			// Refresh visual indicators
			this.plugin.folderNavDecorations?.quickRefresh();

			new Notice(`Folder shared on ${server.name}`);
			this.close();
		} catch (error) {
			new Notice(
				`Failed to create share: ${error instanceof Error ? error.message : "Unknown error"}`
			);
			this.isCreating = false;
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
