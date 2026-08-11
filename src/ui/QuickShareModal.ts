/**
 * The context menu's "sync this folder", as a modal.
 *
 * The words on screen are ADR-0036's: a folder syncs, and there is no share
 * and no server. The class, the client and the API call keep upstream's names.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type Live from "../main";
import type { RelayOnPremServer } from "../RelayOnPremConfig";
import { getDefaultServer, getServerById } from "../RelayOnPremConfig";
import { RelayOnPremShareClient } from "../RelayOnPremShareClient";
import { RelayOnPremShareClientManager } from "../RelayOnPremShareClientManager";

export class QuickShareModal extends Modal {
	private selectedServerId: string | undefined;
	private isCreating = false;

	constructor(
		app: App,
		private plugin: Live,
		private folderPath: string,
	) {
		super(app);
		this.setTitle("Sync this folder");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("relay-quick-share-modal");

		// Ensure share clients are initialized (handles servers added after plugin load)
		this.ensureShareClientsInitialized();

		// Get logged-in servers
		const loggedInServerIds = this.plugin.loginManager.getLoggedInServers();
		const settings = this.plugin.relayOnPremSettings.get();

		if (loggedInServerIds.length === 0) {
			contentEl.createEl("p", {
				text: "Sign in first.",
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
				.setName("Account")
				.setDesc("Which account this folder syncs under")
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
				.setName("Account")
				.setDesc(loggedInServers[0].name);
		}

		// Create button
		const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
		buttonContainer.addClass("evc-flex", "evc-justify-end", "evc-mt-4", "evc-gap-2");

		const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const createBtn = buttonContainer.createEl("button", {
			text: "Start syncing",
			cls: "mod-cta",
		});
		createBtn.addEventListener("click", () => { void this.createShare(); });
	}

	/**
	 * Ensure share clients are initialized.
	 * Handles the case when servers are added/logged in after plugin load.
	 */
	private ensureShareClientsInitialized() {
		const relayOnPremSettings = this.plugin.relayOnPremSettings.get();

		if (this.plugin.shareClientManager) {
			for (const server of relayOnPremSettings.servers) {
				if (!this.plugin.shareClientManager.getClient(server.id)) {
					this.plugin.shareClientManager.addServer(server);
				}
			}
			return;
		}

		if (relayOnPremSettings.enabled && relayOnPremSettings.servers.length > 0) {
			const multiServerAuthManager = this.plugin.loginManager.getMultiServerAuthManager();
			if (multiServerAuthManager) {
				this.plugin.shareClientManager = new RelayOnPremShareClientManager(
					multiServerAuthManager,
					relayOnPremSettings.servers,
				);
				return;
			}
		}

		if (!this.plugin.shareClient && relayOnPremSettings.enabled) {
			const defaultServer = getDefaultServer(relayOnPremSettings);
			if (defaultServer && this.plugin.loginManager.getAuthProvider()) {
				this.plugin.shareClient = new RelayOnPremShareClient(
					defaultServer.controlPlaneUrl,
					async () => {
						const provider = this.plugin.loginManager.getAuthProvider();
						return provider ? await provider.getValidToken() : undefined;
					},
				);
			}
		}
	}

	private async createShare() {
		if (!this.selectedServerId || this.isCreating) {
			return;
		}

		this.isCreating = true;
		const settings = this.plugin.relayOnPremSettings.get();
		const server = getServerById(settings, this.selectedServerId);

		if (!server) {
			new Notice("No account to sync under");
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

			// Create local SharedFolder with relay-onprem marker for CRDT sync
			const sharedFolder = this.plugin.sharedFolders.new(
				this.folderPath,
				share.id,
				"relay-onprem",
				false
			);

			// Store server ID in settings
			if (sharedFolder && sharedFolder.settings) {
				sharedFolder.settings.onpremServerId = this.selectedServerId;
			}

			// Refresh visual indicators
			this.plugin.folderNavDecorations?.quickRefresh();

			new Notice(`${this.folderPath} is syncing now`);
			this.close();
		} catch (error: unknown) {
			new Notice(
				`Could not start syncing: ${error instanceof Error ? error.message : "Unknown error"}`
			);
			this.isCreating = false;
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
