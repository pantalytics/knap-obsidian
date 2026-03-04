/**
 * Share Management Modal
 *
 * Modal for viewing, creating, and managing relay-onprem shares
 * Supports multi-server mode with smart server selection
 */

import { App, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type Live from "../main";
import { RelayOnPremShareClient, type RelayOnPremShare, type ShareMember, type Invite, type FolderItem } from "../RelayOnPremShareClient";
import { RelayOnPremShareClientManager, type ShareWithServer } from "../RelayOnPremShareClientManager";
import { FolderSuggestModal } from "./FolderSuggestModal";
import { getDefaultServer, type RelayOnPremServer } from "../RelayOnPremConfig";
import { S3RN } from "../S3RN";
import { confirmDialog, promptDialog } from "./dialogs";

export class ShareManagementModal extends Modal {
	private shares: ShareWithServer[] = [];
	private selectedShare: ShareWithServer | null = null;
	private members: ShareMember[] = [];
	private invites: Invite[] = [];
	private isOwner = false;
	private isLoading = false;
	private serverId?: string;
	private serverName?: string;
	private webPublishEnabled = false;
	private webPublishDomain: string | null = null;

	constructor(
		app: App,
		private plugin: Live,
		serverId?: string,
		serverName?: string,
	) {
		super(app);
		this.serverId = serverId;
		this.serverName = serverName;

		if (serverName) {
			this.setTitle(`Shares — ${serverName}`);
		} else {
			this.setTitle("Relay on-premise shares");
		}
	}

	onOpen() {
		void this._initOpen();
	}

	private async _initOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("relay-onprem-share-management");

		// Try to initialize share clients if not already done
		// This handles the case when servers are added after plugin load
		this.ensureShareClientsInitialized();

		if (!this.plugin.shareClientManager && !this.plugin.shareClient) {
			contentEl.createEl("p", {
				text: "Please add a server and log in first.",
				cls: "relay-onprem-error",
			});
			return;
		}

		// Loading state
		const loadingDiv = contentEl.createDiv({ cls: "relay-onprem-loading" });
		loadingDiv.createEl("p", { text: "Loading shares..." });

		try {
			await this.loadShares();
			contentEl.empty();
			this.renderContent();
		} catch (error: unknown) {
			contentEl.empty();
			this.showError(
				contentEl,
				error instanceof Error ? error.message : "Failed to load shares",
			);
		}
	}

	/**
	 * Ensure share clients are initialized.
	 * This handles the case when servers are added/logged in after plugin load.
	 */
	private ensureShareClientsInitialized() {
		const relayOnPremSettings = this.plugin.relayOnPremSettings.get();

		// If shareClientManager already exists, sync any new servers from settings
		if (this.plugin.shareClientManager) {
			for (const server of relayOnPremSettings.servers) {
				if (!this.plugin.shareClientManager.getClient(server.id)) {
					this.plugin.shareClientManager.addServer(server);
				}
			}
			return;
		}

		// Try to create multi-server client manager
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

		// Fallback: try to create single-server client
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

	private async loadShares() {
		// Use new multi-server manager if available
		if (this.plugin.shareClientManager) {
			if (this.serverId) {
				// Load shares only for specific server
				const shares = await this.plugin.shareClientManager.listShares(this.serverId);
				this.shares = shares.map(share => ({
					...share,
					serverId: this.serverId!,
					serverName: this.serverName || this.serverId!,
				}));
			} else {
				// Load all shares from all servers
				this.shares = await this.plugin.shareClientManager.getAllSharesFlat();
			}
		} else if (this.plugin.shareClient) {
			// Fallback to legacy single-client
			const shares = await this.plugin.shareClient.listShares();
			this.shares = shares.map(share => ({
				...share,
				serverId: "default",
				serverName: "Default Server",
			}));
		}
	}

	private async loadShareDetails(share: ShareWithServer) {
		try {
			this.isLoading = true;
			this.selectedShare = share;
			this.invites = [];
			this.isOwner = false;

			// Show loading indicator immediately
			const { contentEl } = this;
			contentEl.empty();
			const loadingDiv = contentEl.createDiv({ cls: "relay-onprem-loading" });
			loadingDiv.createEl("p", { text: "Loading share details..." });

			// Determine if current user is the owner (local check, no network)
			const multiServerAuth = this.plugin.loginManager.getMultiServerAuthManager();
			if (multiServerAuth) {
				const currentUser = multiServerAuth.getUserForServer(share.serverId);
				this.isOwner = currentUser?.id === share.owner_user_id;
			} else {
				const authProvider = this.plugin.loginManager.getAuthProvider();
				const currentUser = authProvider?.getCurrentUser();
				this.isOwner = currentUser?.id === share.owner_user_id;
			}

			// Run all API calls in parallel for faster loading
			const serverInfoPromise = (async () => {
				try {
					if (this.plugin.shareClientManager) {
						const client = this.plugin.shareClientManager.getClient(share.serverId);
						if (client) {
							return await client.getServerInfo();
						}
					} else if (this.plugin.shareClient) {
						return await this.plugin.shareClient.getServerInfo();
					}
				} catch {
					console.debug("[ShareManagement] Failed to get server info, web publishing disabled");
				}
				return null;
			})();

			const membersPromise = (async () => {
				if (this.plugin.shareClientManager) {
					return this.plugin.shareClientManager.getShareMembers(share.serverId, share.id);
				} else if (this.plugin.shareClient) {
					return this.plugin.shareClient.getShareMembers(share.id);
				}
				return [] as ShareMember[];
			})();

			const invitesPromise = (async () => {
				if (!this.isOwner) return [] as Invite[];
				try {
					if (this.plugin.shareClientManager) {
						return await this.plugin.shareClientManager.listInvites(share.serverId, share.id);
					} else if (this.plugin.shareClient) {
						return await this.plugin.shareClient.listInvites(share.id);
					}
				} catch (inviteError: unknown) {
					const errorMessage = inviteError instanceof Error ? inviteError.message : "";
					if (errorMessage.includes("403") || errorMessage.includes("Insufficient permissions")) {
						console.debug("[ShareManagement] User is not owner, skipping invites");
						this.isOwner = false;
					} else {
						throw inviteError;
					}
				}
				return [] as Invite[];
			})();

			const [serverInfo, members, invites] = await Promise.all([
				serverInfoPromise,
				membersPromise,
				invitesPromise,
			]);

			this.webPublishEnabled = serverInfo?.features?.web_publish_enabled ?? false;
			this.webPublishDomain = serverInfo?.features?.web_publish_domain ?? null;
			this.members = members;
			this.invites = invites;

			this.renderContent();
		} catch (error: unknown) {
			new Notice(
				`Failed to load share details: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		} finally {
			this.isLoading = false;
		}
	}

	private renderContent() {
		const { contentEl } = this;
		contentEl.empty();

		if (this.selectedShare) {
			this.renderShareDetails();
		} else {
			this.renderShareList();
		}
	}

	private renderShareList() {
		const { contentEl } = this;

		// Create button row (no duplicate header - modal title is enough)
		const headerDiv = contentEl.createDiv({ cls: "relay-onprem-share-header" });
		headerDiv.addClass("evc-flex", "evc-justify-end", "evc-mb-3");

		const createButton = headerDiv.createEl("button", {
			text: "Create share",
			cls: "mod-cta",
		});
		createButton.addEventListener("click", () => { void this.showCreateShareForm(); });

		// Shares list
		if (this.shares.length === 0) {
			contentEl.createEl("p", {
				text: "No shares yet. Create your first share to get started!",
				cls: "relay-onprem-empty",
			});
			return;
		}

		const listDiv = contentEl.createDiv({ cls: "relay-onprem-share-list evc-share-list" });

		this.shares.forEach((share) => {
			const shareItem = listDiv.createDiv({ cls: "relay-onprem-share-item evc-share-item" });

			shareItem.addEventListener("click", () => { void this.loadShareDetails(share); });

			const nameDiv = shareItem.createDiv({ cls: "share-name evc-share-name" });
			nameDiv.textContent = share.path;

			const kindDiv = shareItem.createDiv({ cls: "share-kind evc-text-muted evc-text-sm" });
			kindDiv.textContent = `${share.kind} • ${share.visibility}`;

			// Show server name if multi-server mode
			if (this.plugin.shareClientManager && this.plugin.shareClientManager.getServerCount() > 1) {
				const serverDiv = shareItem.createDiv({ cls: "share-server evc-text-xs evc-text-accent" });
				serverDiv.textContent = `Server: ${share.serverName}`;
			}

			const dateDiv = shareItem.createDiv({ cls: "share-date evc-text-xs evc-text-faint" });
			dateDiv.textContent = `Created: ${new Date(share.created_at).toLocaleDateString()}`;
		});
	}

	private renderShareDetails() {
		if (!this.selectedShare) return;

		const { contentEl } = this;

		// Back button
		const backButton = contentEl.createEl("button", {
			text: "Back to list",
			cls: "mod-muted evc-mb-3",
		});
		backButton.addEventListener("click", () => {
			this.selectedShare = null;
			this.members = [];
			this.invites = [];
			this.renderContent();
		});

		// Share details header with compact info
		contentEl.createEl("h3", { text: this.selectedShare.path });

		// Compact info row
		const infoRow = contentEl.createDiv({ cls: "relay-onprem-share-info evc-share-info-row" });

		// Type badge
		const typeBadge = infoRow.createSpan({ cls: "relay-onprem-badge evc-badge" });
		typeBadge.textContent = `${this.selectedShare.kind} • ${this.selectedShare.visibility}`;

		// Server badge (multi-server mode only)
		if (this.plugin.shareClientManager && this.plugin.shareClientManager.getServerCount() > 1) {
			const serverBadge = infoRow.createSpan({ cls: "relay-onprem-badge evc-badge" });
			serverBadge.textContent = `🖥 ${this.selectedShare.serverName}`;
		}

		// Created date
		const createdSpan = infoRow.createSpan();
		createdSpan.textContent = `Created: ${new Date(this.selectedShare.created_at).toLocaleDateString()}`;

		// Copy ID button
		const copyBtn = infoRow.createEl("button", { cls: "mod-muted evc-btn-sm" });
		copyBtn.textContent = "Copy ID";
		copyBtn.addEventListener("click", () => {
			void navigator.clipboard.writeText(this.selectedShare!.id);
			new Notice("Share ID copied to clipboard");
		});

		// Section order (v1.9.1): Local Folder → Members → Add Member → Invites → Web Publishing → Actions

		// Local folder connection section (folder shares only)
		if (this.selectedShare.kind === "folder") {
			this.renderLocalFolderSection();
		}

		// Members section
		contentEl.createEl("h4", { text: "Members" });

		if (this.members.length === 0) {
			contentEl.createEl("p", {
				text: "No members yet. Add members to collaborate.",
				cls: "relay-onprem-empty",
			});
		} else {
			const membersDiv = contentEl.createDiv({ cls: "relay-onprem-members" });

			this.members.forEach((member) => {
				const setting = new Setting(membersDiv)
					.setName(member.user_email)
					.setDesc(`ID: ${member.user_id.substring(0, 8)}...`);

				// Only owners can change roles and remove members
				if (this.isOwner) {
					setting.addDropdown((dropdown) => {
						dropdown
							.addOption("viewer", "Viewer")
							.addOption("editor", "Editor")
							.setValue(member.role)
							.onChange(async (value) => {
								await this.changeMemberRole(member.user_id, value as "viewer" | "editor");
							});
					});
					setting.addButton((button) => {
						button
							.setButtonText("Remove")
							.setWarning()
							.onClick(() => this.removeMember(member.user_id));
					});
				} else {
					setting.setDesc(`Role: ${member.role} • ID: ${member.user_id.substring(0, 8)}...`);
				}
			});
		}

		// Add member section - only for owners
		if (this.isOwner) {
			contentEl.createEl("h4", { text: "Add member" });

			let userIdInput: HTMLInputElement;
			let roleSelect: HTMLSelectElement;

			new Setting(contentEl)
				.setName("User email")
				.setDesc("Enter email address of user to add as member")
				.addText((text) => {
					userIdInput = text.inputEl;
					text.setPlaceholder("E.g., user@example.com");
				});

			new Setting(contentEl).setName("Role").addDropdown((dropdown) => {
				roleSelect = dropdown.selectEl;
				dropdown.addOption("viewer", "Viewer");
				dropdown.addOption("editor", "Editor");
				dropdown.setValue("editor");
			});

			new Setting(contentEl).addButton((button) => {
				button
					.setButtonText("Add member")
					.setCta()
					.onClick(async () => {
						const userEmail = userIdInput.value.trim();
						const role = roleSelect.value as "viewer" | "editor";

						if (!userEmail) {
							new Notice("Please enter a user email");
							return;
						}

						await this.searchAndAddMember(userEmail, role);
					});
			});
		}

		// Invites section - only for owners
		if (this.isOwner) {
			this.renderInvitesSection();
		}

		// Web Publishing section - only for owners when server supports it (moved here in v1.8.3)
		if (this.isOwner && this.webPublishEnabled) {
			this.renderWebPublishingSection();
		}

		// Actions - only for owners
		if (this.isOwner) {
			this.renderActionsSection();
		}
	}

	/**
	 * Render local folder connection section for folder shares
	 */
	private renderLocalFolderSection() {
		if (!this.selectedShare) return;

		const { contentEl } = this;
		const localFolder = this.plugin.sharedFolders.find(
			(sf) => sf.guid === this.selectedShare!.id
		);

		contentEl.createEl("h4", { text: "Local folder" });

		if (localFolder) {
			new Setting(contentEl)
				.setName(localFolder.path)
				.setDesc("Connected and syncing")
				.addButton((button) => {
					button
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							const ok = await confirmDialog(
								this.app,
								`Disconnect local folder "${localFolder.path}" from this share? Local files will not be deleted.`
							);
							if (!ok) return;
							this.plugin.sharedFolders.delete(localFolder);
							this.plugin.folderNavDecorations?.quickRefresh();
							new Notice("Folder disconnected");
							this.renderContent();
						});
				});
		} else {
			new Setting(contentEl)
				.setName("Not connected")
				.setDesc("Connect a local folder to start syncing")
				.addButton((button) => {
					button
						.setButtonText("Connect to local folder")
						.setCta()
						.onClick(() => {
							const modal = new FolderSuggestModal(
								this.plugin.app,
								"Choose local folder for this share...",
								new Set(),
								this.plugin.sharedFolders,
								(folderPath: string) => {
									try {
										const sharedFolder = this.plugin.sharedFolders.new(
											folderPath,
											this.selectedShare!.id,
											"relay-onprem",
											true
										);
										if (sharedFolder && sharedFolder.settings) {
											sharedFolder.settings.onpremServerId = this.selectedShare!.serverId;
										}
										this.plugin.folderNavDecorations?.quickRefresh();
										new Notice("Folder connected! Syncing...");
										this.renderContent();
									} catch (e: unknown) {
										new Notice(`Failed to connect folder: ${e instanceof Error ? e.message : "Unknown error"}`);
									}
								},
							);
							modal.open();
						});
				});
		}
	}

	/**
	 * Render Actions section with visibility change and delete (v1.8.3)
	 */
	private renderActionsSection() {
		if (!this.selectedShare) return;

		const { contentEl } = this;

		contentEl.createEl("h4", { text: "Actions" });

		// Visibility change dropdown (v1.8.3)
		new Setting(contentEl)
			.setName("Change visibility")
			.setDesc("Control who can access this share")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("private", "Private - only members")
					.addOption("public", "Public - anyone with link")
					.addOption("protected", "Protected - password required")
					.setValue(this.selectedShare!.visibility)
					.onChange(async (value) => {
						await this.updateVisibility(value as "private" | "public" | "protected");
					});
			});

		// Delete share
		new Setting(contentEl)
			.setName("Delete share")
			.setDesc("Permanently delete this share and remove all members")
			.addButton((button) => {
				button
					.setButtonText("Delete")
					.setWarning()
					.onClick(() => this.deleteShare());
			});
	}

	/**
	 * Update share visibility (v1.8.3)
	 */
	private async updateVisibility(visibility: "private" | "public" | "protected") {
		if (!this.selectedShare) return;

		// If changing to protected, ask for password
		let password: string | undefined;
		if (visibility === "protected") {
			const passwordInput = await promptDialog(this.app, "Enter password for protected share:");
			if (!passwordInput) {
				new Notice("Password is required for protected shares");
				this.renderContent(); // Re-render to reset dropdown
				return;
			}
			password = passwordInput;
		}

		// Confirm the change
		const confirmed = await confirmDialog(
			this.app,
			`Change visibility to ${visibility}?${visibility === "public" ? "\n\nWarning: This will make the share accessible to anyone with the link." : ""}`
		);
		if (!confirmed) {
			this.renderContent(); // Re-render to reset dropdown
			return;
		}

		try {
			let updatedShare;
			const updatePayload: { visibility: "private" | "public" | "protected"; password?: string } = { visibility };
			if (password) {
				updatePayload.password = password;
			}

			if (this.plugin.shareClientManager) {
				updatedShare = await this.plugin.shareClientManager.updateShare(
					this.selectedShare.serverId,
					this.selectedShare.id,
					updatePayload
				);
			} else if (this.plugin.shareClient) {
				updatedShare = await this.plugin.shareClient.updateShare(
					this.selectedShare.id,
					updatePayload
				);
			} else {
				throw new Error("No share client available");
			}

			this.selectedShare = {
				...this.selectedShare,
				...updatedShare,
			};

			new Notice(`Visibility changed to ${visibility}`);
			this.renderContent();
		} catch (error: unknown) {
			new Notice(
				`Failed to change visibility: ${error instanceof Error ? error.message : "Unknown error"}`
			);
			this.renderContent(); // Re-render to reset dropdown
		}
	}

	private renderWebPublishingSection() {
		if (!this.selectedShare) return;

		const { contentEl } = this;

		contentEl.createEl("h4", { text: "Web publishing" });

		// Web publishing toggle
		const isPublished = this.selectedShare.web_published ?? false;

		new Setting(contentEl)
			.setName("Publish to web")
			.setDesc("Make this share accessible via a web URL")
			.addToggle((toggle) => {
				toggle
					.setValue(isPublished)
					.onChange(async (value) => {
						await this.toggleWebPublishing(value);
					});
			});

		// Show web URL and additional options when published
		if (isPublished && this.selectedShare.web_url) {
			// Web URL with copy button
			new Setting(contentEl)
				.setName("Web URL")
				.setDesc(this.selectedShare.web_url)
				.addButton((button) => {
					button
						.setButtonText("Copy link")
						.onClick(() => {
							if (this.selectedShare?.web_url) {
								void navigator.clipboard.writeText(this.selectedShare.web_url);
								new Notice("Web URL copied to clipboard!");
							}
						});
				})
				.addButton((button) => {
					button
						.setButtonText("Open")
						.onClick(() => {
							if (this.selectedShare?.web_url) {
								window.open(this.selectedShare.web_url, "_blank");
							}
						});
				});

			// Sync button (different for doc vs folder shares)
			if (this.selectedShare.kind === "doc") {
				new Setting(contentEl)
					.setName("Sync content")
					.setDesc("Update the web page with the latest document content")
					.addButton((button) => {
						button
							.setButtonText("Sync now")
							.setCta()
							.onClick(async () => {
								await this.syncWebContent();
							});
					});
			} else if (this.selectedShare.kind === "folder") {
				new Setting(contentEl)
					.setName("Sync folder")
					.setDesc("Update the web page with the latest folder listing")
					.addButton((button) => {
						button
							.setButtonText("Sync now")
							.setCta()
							.onClick(async () => {
								await this.syncFolderItems();
							});
					});
			}

			// Search engine indexing toggle
			const noindex = this.selectedShare.web_noindex ?? true;
			new Setting(contentEl)
				.setName("Allow search engines")
				.setDesc("Allow search engines to index this page")
				.addToggle((toggle) => {
					toggle
						.setValue(!noindex)
						.onChange(async (value) => {
							await this.updateWebNoindex(!value);
						});
				});

			// Sync mode dropdown (v1.8.1) - available for both doc and folder shares
			const syncMode = this.selectedShare.web_sync_mode ?? "manual";
			new Setting(contentEl)
				.setName("Sync mode")
				.setDesc(this.selectedShare.kind === "doc"
					? "How content is synchronized to web"
					: "How folder files are synchronized to web")
				.addDropdown((dropdown) => {
					dropdown
						.addOption("manual", "Manual - sync on demand")
						.addOption("auto", "Auto - sync on file save")
						.setValue(syncMode)
						.onChange(async (value: string) => {
							await this.updateSyncMode(value as "manual" | "auto");
						});
				});

			// Editable web slug
			if (this.selectedShare.web_slug) {
				let slugInput: HTMLInputElement;
				new Setting(contentEl)
					.setName("Web slug")
					.setDesc("Custom URL path (letters, numbers, hyphens)")
					.addText((text) => {
						slugInput = text.inputEl;
						text.setValue(this.selectedShare!.web_slug || "");
						text.setPlaceholder("My-document");
					})
					.addButton((button) => {
						button
							.setButtonText("Save")
							.onClick(async () => {
								const newSlug = slugInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
								if (newSlug && newSlug !== this.selectedShare?.web_slug) {
									await this.updateWebSlug(newSlug);
								}
							});
					});
			}
		}
	}

	/**
	 * Update the web slug for the current share
	 */
	private async updateWebSlug(newSlug: string) {
		if (!this.selectedShare) return;

		try {
			let updatedShare;
			if (this.plugin.shareClientManager) {
				updatedShare = await this.plugin.shareClientManager.updateShare(
					this.selectedShare.serverId,
					this.selectedShare.id,
					{ web_slug: newSlug }
				);
			} else if (this.plugin.shareClient) {
				updatedShare = await this.plugin.shareClient.updateShare(
					this.selectedShare.id,
					{ web_slug: newSlug }
				);
			} else {
				throw new Error("No share client available");
			}

			this.selectedShare = {
				...this.selectedShare,
				...updatedShare,
			};

			new Notice(`Web slug updated to: ${newSlug}`);
			this.renderContent();
		} catch (error: unknown) {
			new Notice(
				`Failed to update slug: ${error instanceof Error ? error.message : "Unknown error"}`
			);
		}
	}

	/**
	 * Sync folder items to web publishing
	 */
	private async syncFolderItems() {
		if (!this.selectedShare || this.selectedShare.kind !== "folder") return;

		try {
			const items = this.getFolderItems(this.selectedShare.path);
			console.debug("[WebSync] Folder items:", items.length, "files from path:", this.selectedShare.path);
			if (items.length === 0) {
				new Notice("Folder is empty or could not be read");
				return;
			}

			let updatedShare;

			if (this.plugin.shareClientManager) {
				console.debug("[WebSync] Using shareClientManager, serverId:", this.selectedShare.serverId);
				updatedShare = await this.plugin.shareClientManager.updateShare(
					this.selectedShare.serverId,
					this.selectedShare.id,
					{ web_folder_items: items }
				);
			} else if (this.plugin.shareClient) {
				console.debug("[WebSync] Using shareClient (single-server)");
				updatedShare = await this.plugin.shareClient.updateShare(
					this.selectedShare.id,
					{ web_folder_items: items }
				);
			} else {
				throw new Error("No share client available");
			}

			console.debug("[WebSync] updateShare response:", JSON.stringify({
				id: updatedShare.id,
				web_slug: updatedShare.web_slug,
				web_published: updatedShare.web_published,
			}));

			// Update local state
			this.selectedShare = {
				...this.selectedShare,
				...updatedShare,
			};

			// Sync content of each markdown file (v1.8 web editing)
			const slug = this.selectedShare.web_slug;
			console.debug("[WebSync] Checking web_slug for content sync:", slug);
			if (slug) {
				let syncedFiles = 0;
				const failedFiles: string[] = [];
				for (const item of items) {
					if (item.type === "doc") {
						try {
							const filePath = `${this.selectedShare.path}/${item.path}`;
							console.debug("[WebSync] Reading content from:", filePath);
							const content = await this.getDocumentContent(filePath);
							console.debug("[WebSync] Content for", item.path, ":", content ? `${content.length} chars` : "NULL");
							if (content) {
								if (this.plugin.shareClientManager) {
									console.debug("[WebSync] Calling syncFolderFileContent for:", item.path);
									await this.plugin.shareClientManager.syncFolderFileContent(
										this.selectedShare.serverId,
										slug,
										item.path,
										content
									);
								} else if (this.plugin.shareClient) {
									await this.plugin.shareClient.syncFolderFileContent(
										slug,
										item.path,
										content
									);
								}
								syncedFiles++;
								console.debug("[WebSync] Successfully synced:", item.path);
							}
						} catch (error: unknown) {
							console.error(`[WebSync] Failed to sync content for ${item.path}:`, error);
							failedFiles.push(item.path);
						}
					}
				}
				if (failedFiles.length > 0) {
					new Notice(`Folder synced: ${syncedFiles} files OK, ${failedFiles.length} failed:\n${failedFiles.join(", ")}`, 8000);
				} else {
					new Notice(`Folder synced: ${items.length} items, ${syncedFiles} files with content!`);
				}
			} else {
				console.debug("[WebSync] No web_slug, skipping content sync");
				new Notice(`Folder synced with ${items.length} items!`);
			}
		} catch (error: unknown) {
			console.error("[WebSync] syncFolderItems error:", error);
			new Notice(
				`Failed to sync folder: ${error instanceof Error ? error.message : "Unknown error"}`
			);
		}
	}

	/**
	 * Sync document content to web publishing
	 */
	private async syncWebContent() {
		if (!this.selectedShare || this.selectedShare.kind !== "doc") return;

		try {
			const content = await this.getDocumentContent(this.selectedShare.path);
			if (!content) {
				new Notice("Could not read document content");
				return;
			}

			let updatedShare;

			if (this.plugin.shareClientManager) {
				updatedShare = await this.plugin.shareClientManager.updateShare(
					this.selectedShare.serverId,
					this.selectedShare.id,
					{ web_content: content }
				);
			} else if (this.plugin.shareClient) {
				updatedShare = await this.plugin.shareClient.updateShare(
					this.selectedShare.id,
					{ web_content: content }
				);
			} else {
				throw new Error("No share client available");
			}

			// Update local state
			this.selectedShare = {
				...this.selectedShare,
				...updatedShare,
			};

			new Notice("Web content synced successfully!");
		} catch (error: unknown) {
			new Notice(
				`Failed to sync content: ${error instanceof Error ? error.message : "Unknown error"}`
			);
		}
	}

	/**
	 * Get the doc_id (S3RN) for a SharedFolder at the given path.
	 * This is used for real-time sync via y-sweet WebSocket.
	 */
	private getDocIdForPath(path: string): string | null {
		try {
			const sharedFolder = this.plugin.sharedFolders.lookup(path);
			if (!sharedFolder) {
				console.debug("[ShareManagement] No SharedFolder found for path:", path);
				return null;
			}
			const docId = S3RN.encode(sharedFolder.s3rn);
			console.debug("[ShareManagement] Got doc_id for path:", path, "->", docId);
			return docId;
		} catch (error: unknown) {
			console.error("[ShareManagement] Failed to get doc_id for path:", path, error);
			return null;
		}
	}

	private async toggleWebPublishing(enabled: boolean) {
		if (!this.selectedShare) return;

		// Warn if enabling web-publish on a private share
		if (enabled && this.selectedShare.visibility === "private") {
			const makePublic = await confirmDialog(
				this.app,
				"This share is private. Web-published pages from private shares require authentication.\n\n" +
				"Would you like to change visibility to public so anyone can view the web page?\n\n" +
				"Click OK to make public, or Cancel to keep private."
			);
			if (makePublic) {
				try {
					if (this.plugin.shareClientManager) {
						await this.plugin.shareClientManager.updateShare(
							this.selectedShare.serverId,
							this.selectedShare.id,
							{ visibility: "public" }
						);
					} else if (this.plugin.shareClient) {
						await this.plugin.shareClient.updateShare(
							this.selectedShare.id,
							{ visibility: "public" }
						);
					}
					this.selectedShare = { ...this.selectedShare, visibility: "public" };
				} catch (e: unknown) {
					console.error("Failed to change visibility:", e);
				}
			}
		}

		try {
			// Build update payload
			const updatePayload: { web_published: boolean; web_content?: string; web_folder_items?: FolderItem[]; web_doc_id?: string } = {
				web_published: enabled
			};

			// If enabling web publishing, sync content based on share type
			if (enabled) {
				if (this.selectedShare.kind === "doc") {
					const content = await this.getDocumentContent(this.selectedShare.path);
					if (content) {
						updatePayload.web_content = content;
					}
				} else if (this.selectedShare.kind === "folder") {
					const items = this.getFolderItems(this.selectedShare.path);
					if (items.length > 0) {
						updatePayload.web_folder_items = items;
					}
				}

				// Get doc_id for real-time sync (if SharedFolder exists)
				const docId = this.getDocIdForPath(this.selectedShare.path);
				if (docId) {
					updatePayload.web_doc_id = docId;
				}
			}

			let updatedShare;

			if (this.plugin.shareClientManager) {
				updatedShare = await this.plugin.shareClientManager.updateShare(
					this.selectedShare.serverId,
					this.selectedShare.id,
					updatePayload
				);
			} else if (this.plugin.shareClient) {
				updatedShare = await this.plugin.shareClient.updateShare(
					this.selectedShare.id,
					updatePayload
				);
			} else {
				throw new Error("No share client available");
			}

			// Update local state
			this.selectedShare = {
				...this.selectedShare,
				...updatedShare,
			};

			new Notice(enabled ? "Share published to web!" : "Share unpublished from web");
			this.renderContent();
		} catch (error: unknown) {
			new Notice(
				`Failed to update web publishing: ${error instanceof Error ? error.message : "Unknown error"}`
			);
		}
	}

	/**
	 * Get document content from the vault for web publishing
	 */
	private async getDocumentContent(path: string): Promise<string | null> {
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const content = await this.app.vault.read(file);
				return content;
			}
			return null;
		} catch (error: unknown) {
			console.error("Failed to read document content:", error);
			return null;
		}
	}

	/**
	 * Get folder items for web publishing navigation
	 */
	private getFolderItems(folderPath: string): FolderItem[] {
		try {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder || !(folder instanceof TFolder)) {
				return [];
			}

			const items: FolderItem[] = [];

			// Recursively get all files in folder
			const processFolder = (currentFolder: TFolder, basePath: string) => {
				for (const child of currentFolder.children) {
					const relativePath = child.path.substring(folderPath.length + 1);

					if (child instanceof TFile) {
						let itemType: "doc" | "canvas" = "doc";
						if (child.extension === "canvas") {
							itemType = "canvas";
						} else if (child.extension !== "md") {
							// Skip non-markdown, non-canvas files
							continue;
						}

						items.push({
							path: relativePath,
							name: child.basename,
							type: itemType
						});
					} else if (child instanceof TFolder) {
						items.push({
							path: relativePath,
							name: child.name,
							type: "folder"
						});
						// Recursively process subfolders
						processFolder(child, relativePath);
					}
				}
			};

			processFolder(folder, "");
			return items;
		} catch (error: unknown) {
			console.error("Failed to get folder items:", error);
			return [];
		}
	}

	private async updateWebNoindex(noindex: boolean) {
		if (!this.selectedShare) return;

		try {
			let updatedShare;

			if (this.plugin.shareClientManager) {
				updatedShare = await this.plugin.shareClientManager.updateShare(
					this.selectedShare.serverId,
					this.selectedShare.id,
					{ web_noindex: noindex }
				);
			} else if (this.plugin.shareClient) {
				updatedShare = await this.plugin.shareClient.updateShare(
					this.selectedShare.id,
					{ web_noindex: noindex }
				);
			} else {
				throw new Error("No share client available");
			}

			// Update local state
			this.selectedShare = {
				...this.selectedShare,
				...updatedShare,
			};

			new Notice(noindex ? "Search engine indexing disabled" : "Search engine indexing enabled");
		} catch (error: unknown) {
			new Notice(
				`Failed to update indexing: ${error instanceof Error ? error.message : "Unknown error"}`
			);
		}
	}

	/**
	 * Update web sync mode (v1.8.1)
	 */
	private async updateSyncMode(mode: "manual" | "auto") {
		if (!this.selectedShare) return;

		try {
			let updatedShare;

			if (this.plugin.shareClientManager) {
				updatedShare = await this.plugin.shareClientManager.updateShare(
					this.selectedShare.serverId,
					this.selectedShare.id,
					{ web_sync_mode: mode }
				);
			} else if (this.plugin.shareClient) {
				updatedShare = await this.plugin.shareClient.updateShare(
					this.selectedShare.id,
					{ web_sync_mode: mode }
				);
			} else {
				throw new Error("No share client available");
			}

			// Update local state
			this.selectedShare = {
				...this.selectedShare,
				...updatedShare,
			};

			// Register/unregister with WebSyncManager
			if (this.plugin.webSyncManager) {
				if (mode === "auto") {
					this.plugin.webSyncManager.registerAutoSyncShare(
						this.selectedShare.path,
						this.selectedShare.id,
						this.selectedShare.serverId,
						this.selectedShare.kind,
						this.selectedShare.web_slug ?? undefined
					);
					new Notice("Auto-sync enabled - changes will sync on save");
				} else {
					this.plugin.webSyncManager.unregisterAutoSyncShare(this.selectedShare.path);
					new Notice("Auto-sync disabled, use sync now to update");
				}
			} else {
				new Notice(`Sync mode changed to ${mode}`);
			}
		} catch (error: unknown) {
			new Notice(
				`Failed to update sync mode: ${error instanceof Error ? error.message : "Unknown error"}`
			);
		}
	}

	private renderInvitesSection() {
		if (!this.selectedShare) return;

		const { contentEl } = this;

		// Invites section header
		const invitesHeaderDiv = contentEl.createDiv({ cls: "relay-onprem-invites-header" });
		invitesHeaderDiv.addClass("evc-flex", "evc-justify-between", "evc-align-center", "evc-mt-4");

		invitesHeaderDiv.createEl("h4", { text: "Invite links" });

		const createInviteButton = invitesHeaderDiv.createEl("button", {
			text: "Create invite",
			cls: "mod-cta evc-btn-sm",
		});
		createInviteButton.addEventListener("click", () => this.showCreateInviteForm());

		// Active invites list
		const activeInvites = this.invites.filter(invite => !invite.revoked_at);

		if (activeInvites.length === 0) {
			contentEl.createEl("p", {
				text: "No active invite links. Create one to share access.",
				cls: "relay-onprem-empty",
			});
		} else {
			const invitesDiv = contentEl.createDiv({ cls: "relay-onprem-invites" });

			activeInvites.forEach((invite) => {
				const isExpired = !!(invite.expires_at && new Date(invite.expires_at) < new Date());
				const isMaxedOut = invite.max_uses !== null && invite.use_count >= invite.max_uses;
				const isValid = !isExpired && !isMaxedOut;

				new Setting(invitesDiv)
					.setName(`${invite.role} invite`)
					.setDesc(this.getInviteDescription(invite, isExpired, isMaxedOut))
					.addButton((button) => {
						button
							.setButtonText("Copy link")
							.onClick(() => { void this.copyInviteLink(invite); });
					})
					.addButton((button) => {
						button
							.setButtonText("Revoke")
							.setWarning()
							.onClick(() => { void this.revokeInvite(invite.id); });
					});

				// Add visual indicator for expired/maxed invites
				if (!isValid) {
					const settingEl = invitesDiv.lastElementChild as HTMLElement;
					if (settingEl) {
						settingEl.addClass("evc-opacity-60");
					}
				}
			});
		}
	}

	private getInviteDescription(invite: Invite, isExpired: boolean, isMaxedOut: boolean): string {
		const parts: string[] = [];

		// Status
		if (isExpired) {
			parts.push("EXPIRED");
		} else if (isMaxedOut) {
			parts.push("MAX USES REACHED");
		}

		// Expiration
		if (invite.expires_at) {
			const expiresDate = new Date(invite.expires_at);
			parts.push(`Expires: ${expiresDate.toLocaleDateString()}`);
		} else {
			parts.push("No expiration");
		}

		// Usage
		if (invite.max_uses !== null) {
			parts.push(`Uses: ${invite.use_count}/${invite.max_uses}`);
		} else {
			parts.push(`Uses: ${invite.use_count}`);
		}

		return parts.join(" • ");
	}

	private showCreateInviteForm() {
		if (!this.selectedShare) return;

		const { contentEl } = this;
		contentEl.empty();

		// Back button
		const backButton = contentEl.createEl("button", {
			text: "Back to share",
			cls: "mod-muted evc-mb-3",
		});
		backButton.addEventListener("click", () => { void this.loadShareDetails(this.selectedShare!); });

		contentEl.createEl("h3", { text: "Create invite link" });

		let roleSelect: HTMLSelectElement;
		let expirationSelect: HTMLSelectElement;
		let maxUsesInput: HTMLInputElement;

		new Setting(contentEl)
			.setName("Role")
			.setDesc("Access level for invited users")
			.addDropdown((dropdown) => {
				roleSelect = dropdown.selectEl;
				dropdown.addOption("viewer", "Viewer");
				dropdown.addOption("editor", "Editor");
				dropdown.setValue("editor");
			});

		new Setting(contentEl)
			.setName("Expiration")
			.setDesc("How long the invite link will be valid")
			.addDropdown((dropdown) => {
				expirationSelect = dropdown.selectEl;
				dropdown.addOption("7", "7 days");
				dropdown.addOption("14", "14 days");
				dropdown.addOption("30", "30 days");
				dropdown.addOption("0", "No expiration");
				dropdown.setValue("7");
			});

		new Setting(contentEl)
			.setName("Max uses (optional)")
			.setDesc("Limit how many times this invite can be used")
			.addText((text) => {
				maxUsesInput = text.inputEl;
				text.setPlaceholder("Unlimited");
				text.inputEl.type = "number";
				text.inputEl.min = "1";
			});

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText("Create invite link")
				.setCta()
				.onClick(async () => {
					const role = roleSelect.value as "viewer" | "editor";
					const expiresInDays = parseInt(expirationSelect.value, 10);
					const maxUsesValue = maxUsesInput.value.trim();
					const maxUses = maxUsesValue ? parseInt(maxUsesValue, 10) : null;

					if (maxUses !== null && (isNaN(maxUses) || maxUses < 1)) {
						new Notice("Max uses must be a positive number");
						return;
					}

					await this.createInvite(
						role,
						expiresInDays === 0 ? null : expiresInDays,
						maxUses
					);
				});
		});
	}

	private async createInvite(
		role: "viewer" | "editor",
		expiresInDays: number | null,
		maxUses: number | null
	) {
		if (!this.selectedShare) return;

		try {
			if (this.plugin.shareClientManager) {
				await this.plugin.shareClientManager.createInvite(
					this.selectedShare.serverId,
					this.selectedShare.id,
					{
						role,
						expires_in_days: expiresInDays,
						max_uses: maxUses,
					}
				);
			} else if (this.plugin.shareClient) {
				await this.plugin.shareClient.createInvite(this.selectedShare.id, {
					role,
					expires_in_days: expiresInDays,
					max_uses: maxUses,
				});
			} else {
				throw new Error("No share client available");
			}

			new Notice("Invite link created successfully!");
			await this.loadShareDetails(this.selectedShare);
		} catch (error: unknown) {
			new Notice(
				`Failed to create invite: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	private copyInviteLink(invite: Invite) {
		if (!this.selectedShare) return;

		// Get the control plane URL for the server
		let controlPlaneUrl: string;

		if (this.plugin.shareClientManager) {
			const server = this.plugin.shareClientManager.getServer(this.selectedShare.serverId);
			if (!server) {
				new Notice("Server not found");
				return;
			}
			controlPlaneUrl = server.controlPlaneUrl;
		} else if (this.plugin.shareClient) {
			// Legacy single-server mode - get from first server
			const settings = this.plugin.relayOnPremSettings.get();
			if (settings.servers.length === 0) {
				new Notice("No server configured");
				return;
			}
			controlPlaneUrl = settings.servers[0].controlPlaneUrl;
		} else {
			new Notice("Share client not available");
			return;
		}

		// Normalize URL - remove trailing slashes
		const normalizedUrl = controlPlaneUrl.replace(/\/+$/, "");
		// Use /invite/{token}/page for browser-friendly HTML page (not raw JSON)
		const inviteLink = `${normalizedUrl}/invite/${invite.token}/page`;
		void navigator.clipboard.writeText(inviteLink);
		new Notice("Invite link copied to clipboard!");
	}

	private async revokeInvite(inviteId: string) {
		if (!this.selectedShare) return;

		const confirmed = await confirmDialog(this.app, "Are you sure you want to revoke this invite link?");
		if (!confirmed) return;

		try {
			if (this.plugin.shareClientManager) {
				await this.plugin.shareClientManager.revokeInvite(
					this.selectedShare.serverId,
					this.selectedShare.id,
					inviteId
				);
			} else if (this.plugin.shareClient) {
				await this.plugin.shareClient.revokeInvite(this.selectedShare.id, inviteId);
			}

			new Notice("Invite link revoked");
			await this.loadShareDetails(this.selectedShare);
		} catch (error: unknown) {
			new Notice(
				`Failed to revoke invite: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	private getLoggedInServers(): RelayOnPremServer[] {
		const settings = this.plugin.relayOnPremSettings.get();
		const loggedInServerIds = this.plugin.loginManager.getLoggedInServers();
		return settings.servers.filter(s => loggedInServerIds.includes(s.id));
	}

	private showCreateShareForm() {
		const { contentEl } = this;
		contentEl.empty();

		// Back button
		const backButton = contentEl.createEl("button", {
			text: "Cancel",
			cls: "mod-muted evc-mb-3",
		});
		backButton.addEventListener("click", () => this.renderContent());

		contentEl.createEl("h3", { text: "Create new share" });

		let selectedPath: string = "";
		let kindSelect: HTMLSelectElement;
		let visibilitySelect: HTMLSelectElement;
		let selectedServerId: string | undefined;

		// Smart server selection
		const loggedInServers = this.getLoggedInServers();

		if (loggedInServers.length === 0) {
			contentEl.createEl("p", {
				text: "You must be logged in to at least one server to create shares.",
				cls: "relay-onprem-error",
			});
			return;
		}

		// Server selector - only show if multiple servers are logged in
		if (loggedInServers.length > 1) {
			const settings = this.plugin.relayOnPremSettings.get();
			const defaultServer = getDefaultServer(settings);
			selectedServerId = defaultServer?.id || loggedInServers[0].id;

			new Setting(contentEl)
				.setName("Server")
				.setDesc("Select which server to create the share on")
				.addDropdown((dropdown) => {
					loggedInServers.forEach(server => {
						const label = server.id === settings.defaultServerId
							? `${server.name} (Default)`
							: server.name;
						dropdown.addOption(server.id, label);
					});
					dropdown.setValue(selectedServerId!);
					dropdown.onChange((value) => {
						selectedServerId = value;
					});
				});
		} else {
			// Single server, use it automatically
			selectedServerId = loggedInServers[0].id;
		}

		// Path selector with folder suggester
		const pathSetting = new Setting(contentEl)
			.setName("Path")
			.setDesc("Path to the document or folder");

		pathSetting.addButton((button) => {
			button
				.setButtonText(selectedPath || "Choose folder...")
				.setCta()
				.onClick(() => {
					const modal = new FolderSuggestModal(
						this.app,
						"Choose folder for share...",
						new Set(),
						this.plugin.sharedFolders,
						(folderPath: string) => {
							selectedPath = folderPath;
							button.setButtonText(folderPath);
						}
					);
					modal.open();
				});
		});

		new Setting(contentEl)
			.setName("Type")
			.setDesc("Type of share")
			.addDropdown((dropdown) => {
				kindSelect = dropdown.selectEl;
				dropdown.addOption("doc", "Document");
				dropdown.addOption("folder", "Folder");
				dropdown.setValue("doc");
			});

		// Password field container (hidden by default)
		let passwordInput: HTMLInputElement;
		const passwordSettingEl = contentEl.createDiv({ cls: "relay-onprem-password-setting" });
		passwordSettingEl.addClass("evc-hidden");

		new Setting(passwordSettingEl)
			.setName("Password")
			.setDesc("Password required to access this share")
			.addText((text) => {
				passwordInput = text.inputEl;
				text.setPlaceholder("Enter password for protected share");
				text.inputEl.type = "password";
			});

		new Setting(contentEl)
			.setName("Visibility")
			.setDesc("Who can access this share")
			.addDropdown((dropdown) => {
				visibilitySelect = dropdown.selectEl;
				dropdown.addOption("private", "Private");
				dropdown.addOption("public", "Public");
				dropdown.addOption("protected", "Protected (password required)");
				dropdown.setValue("private");
				dropdown.onChange((value) => {
					// Show/hide password field based on visibility
					passwordSettingEl.toggleClass("evc-hidden", value !== "protected");
				});
			});

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText("Create share")
				.setCta()
				.onClick(async () => {
					const path = selectedPath.trim();
					const kind = kindSelect.value as "doc" | "folder";
					const visibility = visibilitySelect.value as "private" | "public" | "protected";
					const password = passwordInput?.value?.trim();

					if (!path) {
						new Notice("Please select a folder path");
						return;
					}

					if (!selectedServerId) {
						new Notice("Please select a server");
						return;
					}

					// Validate password for protected shares
					if (visibility === "protected" && !password) {
						new Notice("Password is required for protected shares");
						return;
					}

					await this.createShare(path, kind, visibility, selectedServerId, password);
				});
		});
	}

	private async createShare(
		path: string,
		kind: "doc" | "folder",
		visibility: "private" | "public" | "protected",
		serverId: string,
		password?: string
	) {
		try {
			let share: RelayOnPremShare;

			const createRequest = {
				path,
				kind,
				visibility,
				...(password && { password }), // Include password only if provided
			};

			if (this.plugin.shareClientManager) {
				share = await this.plugin.shareClientManager.createShare(serverId, createRequest);
			} else if (this.plugin.shareClient) {
				share = await this.plugin.shareClient.createShare(createRequest);
			} else {
				throw new Error("No share client available");
			}

			new Notice(`Share "${share.path}" created successfully!`);

			// Create local SharedFolder for visual indicators and sync
			if (kind === "folder") {
				this.createLocalSharedFolder(share.path, share.id, serverId);
			}

			await this.loadShares();
			this.renderContent();
		} catch (error: unknown) {
			new Notice(
				`Failed to create share: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	private createLocalSharedFolder(folderPath: string, shareGuid: string, serverId: string) {
		try {
			// Create SharedFolder with relay-onprem marker for CRDT sync
			const sharedFolder = this.plugin.sharedFolders.new(
				folderPath,
				shareGuid,
				"relay-onprem",
				false
			);

			// Store the server ID in the shared folder settings
			if (sharedFolder && sharedFolder.settings) {
				sharedFolder.settings.onpremServerId = serverId;
			}

			// Trigger visual indicators refresh
			this.plugin.folderNavDecorations?.quickRefresh();

			console.debug(`[RelayOnPrem] Created SharedFolder for ${folderPath} on server ${serverId}`);
		} catch (error: unknown) {
			console.error(`[RelayOnPrem] Failed to create SharedFolder:`, error);
		}
	}

	private async searchAndAddMember(userEmail: string, role: "viewer" | "editor") {
		if (!this.selectedShare) return;

		try {
			let user;

			if (this.plugin.shareClientManager) {
				user = await this.plugin.shareClientManager.searchUserByEmail(
					this.selectedShare.serverId,
					userEmail
				);
				await this.plugin.shareClientManager.addMember(
					this.selectedShare.serverId,
					this.selectedShare.id,
					{ user_id: user.id, role }
				);
			} else if (this.plugin.shareClient) {
				user = await this.plugin.shareClient.searchUserByEmail(userEmail);
				await this.plugin.shareClient.addMember(this.selectedShare.id, {
					user_id: user.id,
					role,
				});
			} else {
				throw new Error("No share client available");
			}

			new Notice(`Added member to share`);
			await this.loadShareDetails(this.selectedShare);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Failed to add member";
			new Notice(errorMessage);
		}
	}

	private async changeMemberRole(userId: string, role: "viewer" | "editor") {
		if (!this.selectedShare) return;

		try {
			if (this.plugin.shareClientManager) {
				await this.plugin.shareClientManager.updateMemberRole(
					this.selectedShare.serverId,
					this.selectedShare.id,
					userId,
					role
				);
			} else if (this.plugin.shareClient) {
				await this.plugin.shareClient.updateMemberRole(this.selectedShare.id, userId, role);
			}

			new Notice(`Member role changed to ${role}`);
			await this.loadShareDetails(this.selectedShare);
		} catch (error: unknown) {
			new Notice(
				`Failed to change role: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	private async removeMember(userId: string) {
		if (!this.selectedShare) return;

		try {
			if (this.plugin.shareClientManager) {
				await this.plugin.shareClientManager.removeMember(
					this.selectedShare.serverId,
					this.selectedShare.id,
					userId
				);
			} else if (this.plugin.shareClient) {
				await this.plugin.shareClient.removeMember(this.selectedShare.id, userId);
			}

			new Notice("Member removed from share");
			await this.loadShareDetails(this.selectedShare);
		} catch (error: unknown) {
			new Notice(
				`Failed to remove member: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	private async deleteShare() {
		if (!this.selectedShare) return;

		// Confirmation
		const confirmed = await confirmDialog(
			this.app,
			`Are you sure you want to delete "${this.selectedShare.path}"? This action cannot be undone.`
		);

		if (!confirmed) return;

		try {
			if (this.plugin.shareClientManager) {
				await this.plugin.shareClientManager.deleteShare(
					this.selectedShare.serverId,
					this.selectedShare.id
				);
			} else if (this.plugin.shareClient) {
				await this.plugin.shareClient.deleteShare(this.selectedShare.id);
			}

			// Clean up local SharedFolder entry so it doesn't persist as stale
			const localFolder = this.plugin.sharedFolders.find(
				(sf) => sf.guid === this.selectedShare!.id
			);
			if (localFolder) {
				this.plugin.sharedFolders.delete(localFolder);
				this.plugin.folderNavDecorations?.quickRefresh();
			}

			new Notice("Share deleted successfully");
			this.selectedShare = null;
			this.members = [];
			this.invites = [];
			await this.loadShares();
			this.renderContent();
		} catch (error: unknown) {
			new Notice(
				`Failed to delete share: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	private showError(container: HTMLElement, message: string) {
		container.createEl("p", {
			text: message,
			cls: "relay-onprem-error evc-text-error",
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
