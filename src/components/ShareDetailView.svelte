<script lang="ts">
	import { onMount } from "svelte";
	import { Notice, Setting, TFile, TFolder } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import type { ShareMember, Invite, FolderItem } from "../RelayOnPremShareClient";
	import { LimitExceededApiError, VisibilityNotAllowedApiError } from "../RelayOnPremShareClient";
	import type { ShareWithServer } from "../RelayOnPremShareClientManager";
	import { FolderSuggestModal } from "../ui/FolderSuggestModal";
	import { S3RN } from "../S3RN";
	import { confirmDialog, promptDialog, choiceDialog } from "../ui/dialogs";

	export let plugin: Live;
	export let server: RelayOnPremServer;
	export let share: ShareWithServer;

	const dispatch = createEventDispatcher<{
		createInvite: void;
		deleted: void;
		back: void;
	}>();

	let members: ShareMember[] = [];
	let invites: Invite[] = [];
	let isOwner = false;
	let loading = true;
	let webPublishEnabled = false;
	let webPublishDomain: string | null = null;
	let currentShare = share;

	// Add member form
	let newMemberEmail = "";
	let newMemberRole: "viewer" | "editor" = "editor";

	// Web slug editing
	let editingSlug = "";

	onMount(async () => {
		await loadDetails();
	});

	async function loadDetails() {
		loading = true;
		try {
			// Determine ownership
			const multiServerAuth = plugin.loginManager.getMultiServerAuthManager();
			if (multiServerAuth) {
				const currentUser = multiServerAuth.getUserForServer(share.serverId);
				isOwner = currentUser?.id === share.owner_user_id;
			} else {
				const authProvider = plugin.loginManager.getAuthProvider();
				const currentUser = authProvider?.getCurrentUser();
				isOwner = currentUser?.id === share.owner_user_id;
			}

			// Load all data in parallel
			const [serverInfo, membersResult, invitesResult] = await Promise.all([
				loadServerInfo(),
				loadMembers(),
				isOwner ? loadInvites() : Promise.resolve([]),
			]);

			webPublishEnabled = serverInfo?.features?.web_publish_enabled ?? false;
			webPublishDomain = serverInfo?.features?.web_publish_domain ?? null;
			members = membersResult;
			invites = invitesResult;
			editingSlug = currentShare.web_slug || "";
		} catch (e: unknown) {
			new Notice(`Failed to load share details: ${e instanceof Error ? e.message : "Unknown error"}`);
		} finally {
			loading = false;
		}
	}

	async function loadServerInfo() {
		try {
			if (plugin.shareClientManager) {
				const client = plugin.shareClientManager.getClient(share.serverId);
				if (client) return await client.getServerInfo();
			} else if (plugin.shareClient) {
				return await plugin.shareClient.getServerInfo();
			}
		} catch { /* server info optional */ }
		return null;
	}

	async function loadMembers(): Promise<ShareMember[]> {
		if (plugin.shareClientManager) {
			return plugin.shareClientManager.getShareMembers(share.serverId, share.id);
		} else if (plugin.shareClient) {
			return plugin.shareClient.getShareMembers(share.id);
		}
		return [];
	}

	async function loadInvites(): Promise<Invite[]> {
		try {
			if (plugin.shareClientManager) {
				return await plugin.shareClientManager.listInvites(share.serverId, share.id);
			} else if (plugin.shareClient) {
				return await plugin.shareClient.listInvites(share.id);
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : "";
			if (msg.includes("403") || msg.includes("Insufficient permissions")) {
				isOwner = false;
			} else {
				throw e;
			}
		}
		return [];
	}

	function copyId() {
		navigator.clipboard.writeText(currentShare.id);
		new Notice("Share ID copied");
	}

	// Members
	async function addMember() {
		if (!newMemberEmail.trim()) {
			new Notice("Please enter a user email");
			return;
		}
		try {
			let user;
			if (plugin.shareClientManager) {
				user = await plugin.shareClientManager.searchUserByEmail(share.serverId, newMemberEmail.trim());
				await plugin.shareClientManager.addMember(share.serverId, share.id, { user_id: user.id, role: newMemberRole });
			} else if (plugin.shareClient) {
				user = await plugin.shareClient.searchUserByEmail(newMemberEmail.trim());
				await plugin.shareClient.addMember(share.id, { user_id: user.id, role: newMemberRole });
			}
			new Notice("Member added");
			newMemberEmail = "";
			members = await loadMembers();
		} catch (e: unknown) {
			if (e instanceof LimitExceededApiError) {
				const info = e.limitInfo;
				new Notice(
					`Member limit reached (${info.current}/${info.max} on ${info.plan} plan). ` +
					`Upgrade your plan to add more members.`,
					8000,
				);
			} else {
				new Notice(e instanceof Error ? e.message : "Failed to add member");
			}
		}
	}

	async function changeMemberRole(userId: string, role: "viewer" | "editor") {
		try {
			if (plugin.shareClientManager) {
				await plugin.shareClientManager.updateMemberRole(share.serverId, share.id, userId, role);
			} else if (plugin.shareClient) {
				await plugin.shareClient.updateMemberRole(share.id, userId, role);
			}
			new Notice(`Role changed to ${role}`);
			members = await loadMembers();
		} catch (e: unknown) {
			new Notice(`Failed to change role: ${e instanceof Error ? e.message : "Unknown error"}`);
		}
	}

	async function removeMember(userId: string) {
		try {
			if (plugin.shareClientManager) {
				await plugin.shareClientManager.removeMember(share.serverId, share.id, userId);
			} else if (plugin.shareClient) {
				await plugin.shareClient.removeMember(share.id, userId);
			}
			new Notice("Member removed");
			members = await loadMembers();
		} catch (e: unknown) {
			new Notice(`Failed to remove member: ${e instanceof Error ? e.message : "Unknown error"}`);
		}
	}

	// Invites
	function getInviteDescription(invite: Invite): string {
		const isExpired = !!(invite.expires_at && new Date(invite.expires_at) < new Date());
		const isMaxed = invite.max_uses !== null && invite.use_count >= invite.max_uses;
		const parts: string[] = [];
		if (isExpired) parts.push("EXPIRED");
		else if (isMaxed) parts.push("MAX USES REACHED");
		if (invite.expires_at) {
			parts.push(`Expires: ${new Date(invite.expires_at).toLocaleDateString()}`);
		} else {
			parts.push("No expiration");
		}
		parts.push(invite.max_uses !== null ? `Uses: ${invite.use_count}/${invite.max_uses}` : `Uses: ${invite.use_count}`);
		return parts.join(" \u2022 ");
	}

	function isInviteValid(invite: Invite): boolean {
		const isExpired = !!(invite.expires_at && new Date(invite.expires_at) < new Date());
		const isMaxed = invite.max_uses !== null && invite.use_count >= invite.max_uses;
		return !isExpired && !isMaxed;
	}

	function copyInviteLink(invite: Invite) {
		const normalizedUrl = server.controlPlaneUrl.replace(/\/+$/, "");
		const link = `${normalizedUrl}/invite/${invite.token}/page`;
		navigator.clipboard.writeText(link);
		new Notice("Invite link copied!");
	}

	async function revokeInvite(inviteId: string) {
		if (!(await confirmDialog(plugin.app, "Revoke this invite link?"))) return;
		try {
			if (plugin.shareClientManager) {
				await plugin.shareClientManager.revokeInvite(share.serverId, share.id, inviteId);
			} else if (plugin.shareClient) {
				await plugin.shareClient.revokeInvite(share.id, inviteId);
			}
			new Notice("Invite revoked");
			invites = await loadInvites();
		} catch (e: unknown) {
			new Notice(`Failed to revoke invite: ${e instanceof Error ? e.message : "Unknown error"}`);
		}
	}

	// Visibility
	async function updateVisibility(newVisibility: string) {
		let password: string | undefined;
		if (newVisibility === "protected") {
			const input = await promptDialog(plugin.app, "Enter password for protected share:");
			if (!input) {
				new Notice("Password is required for protected shares");
				currentShare = { ...currentShare }; // trigger re-render to reset
				return;
			}
			password = input;
		}
		if (!(await confirmDialog(plugin.app, `Change visibility to ${newVisibility}?`))) {
			currentShare = { ...currentShare };
			return;
		}
		try {
			const payload: any = { visibility: newVisibility };
			if (password) payload.password = password;
			let updated;
			if (plugin.shareClientManager) {
				updated = await plugin.shareClientManager.updateShare(share.serverId, share.id, payload);
			} else if (plugin.shareClient) {
				updated = await plugin.shareClient.updateShare(share.id, payload);
			}
			if (updated) currentShare = { ...currentShare, ...updated };
			new Notice(`Visibility changed to ${newVisibility}`);
		} catch (e: unknown) {
			new Notice(`Failed: ${e instanceof Error ? e.message : "Unknown error"}`);
			currentShare = { ...currentShare };
		}
	}

	// Delete
	async function deleteShare() {
		if (!(await confirmDialog(plugin.app, `Delete "${currentShare.path}"? This cannot be undone.`))) return;
		try {
			if (plugin.shareClientManager) {
				await plugin.shareClientManager.deleteShare(share.serverId, share.id);
			} else if (plugin.shareClient) {
				await plugin.shareClient.deleteShare(share.id);
			}
			// Clean up local SharedFolder
			const localFolder = plugin.sharedFolders.find((sf) => sf.guid === share.id);
			if (localFolder) {
				plugin.sharedFolders.delete(localFolder);
				plugin.folderNavDecorations?.quickRefresh();
			}
			new Notice("Share deleted");
			dispatch("deleted");
		} catch (e: unknown) {
			new Notice(`Failed to delete: ${e instanceof Error ? e.message : "Unknown error"}`);
		}
	}

	// Web Publishing
	async function toggleWebPublishing(enabled: boolean) {
		if (enabled && currentShare.visibility === "private") {
			// Private shares need visibility change before web publishing
			const newVisibility = await choiceDialog(
				plugin.app,
				'This share is private. Web publishing requires "public" or "protected" visibility. Choose how you want to publish:',
				[
					{ label: "Make public (open access)", value: "public" },
					{ label: "Make protected (password)", value: "protected" },
				]
			);
			if (!newVisibility) return; // User cancelled — don't publish

			try {
				const payload = { visibility: newVisibility as "public" | "protected" };
				if (plugin.shareClientManager) {
					await plugin.shareClientManager.updateShare(share.serverId, share.id, payload);
				} else if (plugin.shareClient) {
					await plugin.shareClient.updateShare(share.id, payload);
				}
				currentShare = { ...currentShare, visibility: newVisibility };
			} catch (e: unknown) {
				if (e instanceof VisibilityNotAllowedApiError) {
					const info = e.visibilityInfo;
					new Notice(
						`'${info.visibility}' visibility requires a higher plan. ` +
						`Your plan allows: ${info.allowed.join(", ")}. Upgrade to unlock.`,
						8000,
					);
				} else {
					console.error("Failed to change visibility:", e);
					new Notice("Failed to change visibility");
				}
				return;
			}
		}

		try {
			const updatePayload: any = { web_published: enabled };
			if (enabled) {
				if (currentShare.kind === "doc") {
					const content = await getDocumentContent(currentShare.path);
					if (content) updatePayload.web_content = content;
				} else if (currentShare.kind === "folder") {
					const items = await getFolderItems(currentShare.path);
					if (items.length > 0) updatePayload.web_folder_items = items;
				}
				const docId = getDocIdForPath(currentShare.path);
				if (docId) updatePayload.web_doc_id = docId;
			}

			let updated;
			if (plugin.shareClientManager) {
				updated = await plugin.shareClientManager.updateShare(share.serverId, share.id, updatePayload);
			} else if (plugin.shareClient) {
				updated = await plugin.shareClient.updateShare(share.id, updatePayload);
			}
			if (updated) {
				currentShare = { ...currentShare, ...updated };
				editingSlug = currentShare.web_slug || "";
			}
			new Notice(enabled ? "Published to web!" : "Unpublished from web");
		} catch (e: unknown) {
			if (e instanceof LimitExceededApiError) {
				const info = e.limitInfo;
				new Notice(
					`Web publish limit reached (${info.current}/${info.max} on ${info.plan} plan). ` +
					`Upgrade your plan to publish more.`,
					8000,
				);
			} else if (e instanceof VisibilityNotAllowedApiError) {
				const info = e.visibilityInfo;
				new Notice(
					`'${info.visibility}' visibility requires a higher plan. ` +
					`Your plan allows: ${info.allowed.join(", ")}. Upgrade to unlock.`,
					8000,
				);
			} else {
				new Notice(`Failed: ${e instanceof Error ? e.message : "Unknown error"}`);
			}
		}
	}

	async function syncWebContent() {
		if (currentShare.kind === "doc") {
			try {
				const content = await getDocumentContent(currentShare.path);
				if (!content) { new Notice("Could not read document"); return; }
				let updated;
				if (plugin.shareClientManager) {
					updated = await plugin.shareClientManager.updateShare(share.serverId, share.id, { web_content: content });
				} else if (plugin.shareClient) {
					updated = await plugin.shareClient.updateShare(share.id, { web_content: content });
				}
				if (updated) currentShare = { ...currentShare, ...updated };
				new Notice("Content synced!");
			} catch (e: unknown) {
				new Notice(`Failed to sync: ${e instanceof Error ? e.message : "Unknown error"}`);
			}
		} else if (currentShare.kind === "folder") {
			try {
				const items = await getFolderItems(currentShare.path);
				if (items.length === 0) { new Notice("Folder empty"); return; }
				let updated;
				if (plugin.shareClientManager) {
					updated = await plugin.shareClientManager.updateShare(share.serverId, share.id, { web_folder_items: items });
				} else if (plugin.shareClient) {
					updated = await plugin.shareClient.updateShare(share.id, { web_folder_items: items });
				}
				if (updated) currentShare = { ...currentShare, ...updated };

				// Sync file content
				const slug = currentShare.web_slug;
				if (slug) {
					let synced = 0;
					for (const item of items) {
						if (item.type === "doc") {
							try {
								const content = await getDocumentContent(`${currentShare.path}/${item.path}`);
								if (content) {
									if (plugin.shareClientManager) {
										await plugin.shareClientManager.syncFolderFileContent(share.serverId, slug, item.path, content);
									} else if (plugin.shareClient) {
										await plugin.shareClient.syncFolderFileContent(slug, item.path, content);
									}
									synced++;
								}
							} catch { /* skip individual file errors */ }
						}
					}
					new Notice(`Synced ${synced} files`);
				} else {
					new Notice(`Folder synced: ${items.length} items`);
				}
			} catch (e: unknown) {
				new Notice(`Failed to sync: ${e instanceof Error ? e.message : "Unknown error"}`);
			}
		}
	}

	async function updateWebNoindex(noindex: boolean) {
		try {
			let updated;
			if (plugin.shareClientManager) {
				updated = await plugin.shareClientManager.updateShare(share.serverId, share.id, { web_noindex: noindex });
			} else if (plugin.shareClient) {
				updated = await plugin.shareClient.updateShare(share.id, { web_noindex: noindex });
			}
			if (updated) currentShare = { ...currentShare, ...updated };
			new Notice(noindex ? "Indexing disabled" : "Indexing enabled");
		} catch (e: unknown) {
			new Notice(`Failed: ${e instanceof Error ? e.message : "Unknown error"}`);
		}
	}

	async function updateSyncMode(mode: string) {
		try {
			let updated;
			if (plugin.shareClientManager) {
				updated = await plugin.shareClientManager.updateShare(share.serverId, share.id, { web_sync_mode: mode });
			} else if (plugin.shareClient) {
				updated = await plugin.shareClient.updateShare(share.id, { web_sync_mode: mode });
			}
			if (updated) currentShare = { ...currentShare, ...updated };
			if (plugin.webSyncManager) {
				if (mode === "auto") {
					plugin.webSyncManager.registerAutoSyncShare(
						currentShare.path, currentShare.id, currentShare.serverId,
						currentShare.kind, currentShare.web_slug ?? undefined,
					);
					new Notice("Auto-sync enabled");
				} else {
					plugin.webSyncManager.unregisterAutoSyncShare(currentShare.path);
					new Notice("Auto-sync disabled");
				}
			} else {
				new Notice(`Sync mode: ${mode}`);
			}
		} catch (e: unknown) {
			new Notice(`Failed: ${e instanceof Error ? e.message : "Unknown error"}`);
		}
	}

	async function saveWebSlug() {
		const newSlug = editingSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
		if (!newSlug || newSlug === currentShare.web_slug) return;
		try {
			let updated;
			if (plugin.shareClientManager) {
				updated = await plugin.shareClientManager.updateShare(share.serverId, share.id, { web_slug: newSlug });
			} else if (plugin.shareClient) {
				updated = await plugin.shareClient.updateShare(share.id, { web_slug: newSlug });
			}
			if (updated) {
				currentShare = { ...currentShare, ...updated };
				editingSlug = currentShare.web_slug || "";
			}
			new Notice(`Slug updated: ${newSlug}`);
		} catch (e: unknown) {
			new Notice(`Failed: ${e instanceof Error ? e.message : "Unknown error"}`);
		}
	}

	// Helpers
	function getDocIdForPath(path: string): string | null {
		try {
			const sf = plugin.sharedFolders.lookup(path);
			if (!sf) return null;
			return S3RN.encode(sf.s3rn);
		} catch { return null; }
	}

	async function getDocumentContent(path: string): Promise<string | null> {
		try {
			const file = plugin.app.vault.getAbstractFileByPath(path);
			if (file && "extension" in file) return await plugin.app.vault.read(file as any);
			return null;
		} catch { return null; }
	}

	async function getFolderItems(folderPath: string): Promise<FolderItem[]> {
		try {
			const folder = plugin.app.vault.getAbstractFileByPath(folderPath);
			if (!folder || !(folder instanceof TFolder)) return [];
			const items: FolderItem[] = [];
			const process = (f: TFolder) => {
				for (const child of f.children) {
					const rel = child.path.substring(folderPath.length + 1);
					if (child instanceof TFile) {
						if (child.extension === "canvas") {
							items.push({ path: rel, name: child.basename, type: "canvas" });
						} else if (child.extension === "md") {
							items.push({ path: rel, name: child.basename, type: "doc" });
						}
					} else if (child instanceof TFolder) {
						items.push({ path: rel, name: child.name, type: "folder" });
						process(child);
					}
				}
			};
			process(folder);
			return items;
		} catch { return []; }
	}

	$: activeInvites = invites.filter(i => !i.revoked_at);
	$: isPublished = currentShare.web_published ?? false;
	$: syncMode = currentShare.web_sync_mode ?? "manual";
	$: noindex = currentShare.web_noindex ?? true;

	// Local folder connection
	let isConnectedLocally = false;
	let localFolderPath = "";

	function checkLocalConnection() {
		const localFolder = plugin.sharedFolders.find((sf) => sf.guid === share.id);
		isConnectedLocally = !!localFolder;
		localFolderPath = localFolder ? localFolder.path : "";
	}

	// Check on mount and whenever loading finishes
	$: if (!loading) checkLocalConnection();

	function connectToFolder() {
		const modal = new FolderSuggestModal(
			plugin.app,
			"Choose local folder for this share...",
			new Set(),
			plugin.sharedFolders,
			(folderPath: string) => {
				try {
					const sharedFolder = plugin.sharedFolders.new(folderPath, share.id, "relay-onprem", true);
					if (sharedFolder && sharedFolder.settings) {
						sharedFolder.settings.onpremServerId = share.serverId;
					}
					plugin.folderNavDecorations?.quickRefresh();
					new Notice("Folder connected! Syncing...");
					checkLocalConnection();
				} catch (e: unknown) {
					new Notice(`Failed to connect folder: ${e instanceof Error ? e.message : "Unknown error"}`);
				}
			},
		);
		modal.open();
	}

	async function disconnectFolder() {
		if (!(await confirmDialog(plugin.app, `Disconnect local folder "${localFolderPath}" from this share? Local files will not be deleted.`))) return;
		const localFolder = plugin.sharedFolders.find((sf) => sf.guid === share.id);
		if (localFolder) {
			plugin.sharedFolders.delete(localFolder);
			plugin.folderNavDecorations?.quickRefresh();
			new Notice("Folder disconnected");
			checkLocalConnection();
		}
	}
</script>

<div class="evc-share-detail">
	{#if loading}
		<div class="evc-loading">Loading share details...</div>
	{:else}
		<!-- Share Info -->
		<div class="evc-detail-header">
			<h3 class="evc-detail-title">{currentShare.path}</h3>
			<div class="evc-detail-badges">
				<span class="evc-badge">{currentShare.kind}</span>
				<span class="evc-badge evc-badge-{currentShare.visibility}">{currentShare.visibility}</span>
				<span class="evc-detail-date">{new Date(currentShare.created_at).toLocaleDateString()}</span>
				<button class="evc-link-btn" on:click={copyId}>Copy ID</button>
			</div>
		</div>

		<!-- Local Folder Connection (folder shares only) -->
		{#if currentShare.kind === "folder"}
			<div class="evc-section">
				<div class="evc-section-title">Local Folder</div>
				{#if isConnectedLocally}
					<div class="evc-connection-row">
						<div class="evc-connection-info">
							<span class="evc-connection-path">{localFolderPath}</span>
							<span class="evc-connection-status">Connected and syncing</span>
						</div>
						<button class="evc-btn-danger evc-small-btn" on:click={disconnectFolder}>Disconnect</button>
					</div>
				{:else}
					<div class="evc-connection-row">
						<div class="evc-connection-info">
							<span class="evc-connection-status">Not connected to a local folder</span>
						</div>
						<button class="mod-cta" on:click={connectToFolder}>Connect to local folder</button>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Members -->
		<div class="evc-section">
			<div class="evc-section-title">Members</div>
			{#if members.length === 0}
				<div class="evc-empty-inline">No members yet.</div>
			{:else}
				<div class="evc-member-list">
					{#each members as member (member.id)}
						<div class="evc-member-item">
							<div class="evc-member-info">
								<span class="evc-member-email">{member.user_email}</span>
								{#if !isOwner}
									<span class="evc-badge">{member.role}</span>
								{/if}
							</div>
							{#if isOwner}
								<div class="evc-member-actions">
									<select
										class="dropdown evc-role-select"
										value={member.role}
										on:change={(e) => changeMemberRole(member.user_id, e.currentTarget.value)}
									>
										<option value="viewer">Viewer</option>
										<option value="editor">Editor</option>
									</select>
									<button class="evc-btn-danger" on:click={() => removeMember(member.user_id)}>Remove</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			{#if isOwner}
				<div class="evc-add-member">
					<input
						type="text"
						placeholder="user@example.com"
						bind:value={newMemberEmail}
						on:keypress={(e) => { if (e.key === 'Enter') addMember(); }}
					/>
					<select class="dropdown evc-role-select" bind:value={newMemberRole}>
						<option value="viewer">Viewer</option>
						<option value="editor">Editor</option>
					</select>
					<button class="mod-cta" on:click={addMember}>Add</button>
				</div>
			{/if}
		</div>

		<!-- Invites (owner only) -->
		{#if isOwner}
			<div class="evc-section">
				<div class="evc-section-header">
					<div class="evc-section-title">Invite Links</div>
					<button class="evc-small-btn" on:click={() => dispatch('createInvite')}>Create Invite</button>
				</div>
				{#if activeInvites.length === 0}
					<div class="evc-empty-inline">No active invite links.</div>
				{:else}
					<div class="evc-invite-list">
						{#each activeInvites as invite (invite.id)}
							<div class="evc-invite-item" class:evc-invite-invalid={!isInviteValid(invite)}>
								<div class="evc-invite-info">
									<span class="evc-invite-role">{invite.role} invite</span>
									<span class="evc-invite-desc">{getInviteDescription(invite)}</span>
								</div>
								<div class="evc-invite-actions">
									<button class="evc-small-btn" on:click={() => copyInviteLink(invite)}>Copy Link</button>
									<button class="evc-btn-danger evc-small-btn" on:click={() => revokeInvite(invite.id)}>Revoke</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Web Publishing (owner + server supports it) -->
		{#if isOwner && webPublishEnabled}
			<div class="evc-section">
				<div class="evc-section-title">Web Publishing</div>

				<div class="evc-setting-row">
					<div class="evc-setting-info">
						<span>Publish to Web</span>
					</div>
					<label class="checkbox-container">
						<input type="checkbox" checked={isPublished} on:change={(e) => toggleWebPublishing(e.currentTarget.checked)} />
					</label>
				</div>

				{#if isPublished}
					{#if currentShare.web_url}
						<div class="evc-setting-row">
							<div class="evc-setting-info">
								<span>Web URL</span>
								<span class="evc-setting-desc">{currentShare.web_url}</span>
							</div>
							<div class="evc-setting-actions">
								<button class="evc-small-btn" on:click={() => { navigator.clipboard.writeText(currentShare.web_url || ''); new Notice('URL copied!'); }}>Copy</button>
								<button class="evc-small-btn" on:click={() => window.open(currentShare.web_url || '', '_blank')}>Open</button>
							</div>
						</div>
					{/if}

					<div class="evc-setting-row">
						<div class="evc-setting-info">
							<span>Sync Content</span>
						</div>
						<button class="mod-cta evc-small-btn" on:click={syncWebContent}>Sync Now</button>
					</div>

					<div class="evc-setting-row">
						<div class="evc-setting-info">
							<span>Allow search engines</span>
						</div>
						<label class="checkbox-container">
							<input type="checkbox" checked={!noindex} on:change={(e) => updateWebNoindex(!e.currentTarget.checked)} />
						</label>
					</div>

					<div class="evc-setting-row">
						<div class="evc-setting-info">
							<span>Sync Mode</span>
						</div>
						<select class="dropdown" value={syncMode} on:change={(e) => updateSyncMode(e.currentTarget.value)}>
							<option value="manual">Manual</option>
							<option value="auto">Auto</option>
						</select>
					</div>

					{#if currentShare.web_slug}
						<div class="evc-setting-row">
							<div class="evc-setting-info">
								<span>Web Slug</span>
							</div>
							<div class="evc-slug-edit">
								<input type="text" bind:value={editingSlug} placeholder="my-document" />
								<button class="evc-small-btn" on:click={saveWebSlug}>Save</button>
							</div>
						</div>
					{/if}
				{/if}
			</div>
		{/if}

		<!-- Actions (owner only) -->
		{#if isOwner}
			<div class="evc-section">
				<div class="evc-section-title">Actions</div>

				<div class="evc-setting-row">
					<div class="evc-setting-info">
						<span>Change Visibility</span>
						<span class="evc-setting-desc">Control who can access this share</span>
					</div>
					<select
						class="dropdown"
						value={currentShare.visibility}
						on:change={(e) => updateVisibility(e.currentTarget.value)}
					>
						<option value="private">Private</option>
						<option value="public">Public</option>
						<option value="protected">Protected</option>
					</select>
				</div>

				<div class="evc-setting-row">
					<div class="evc-setting-info">
						<span>Delete Share</span>
						<span class="evc-setting-desc">Permanently delete this share</span>
					</div>
					<button class="evc-btn-danger" on:click={deleteShare}>Delete</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.evc-share-detail {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.evc-loading {
		padding: 24px;
		text-align: center;
		color: var(--text-muted);
	}

	.evc-detail-header {
		padding-bottom: 12px;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.evc-detail-title {
		margin: 0 0 8px 0;
		padding: 0;
		font-size: 1.2em;
	}

	.evc-detail-badges {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 0.85em;
	}

	.evc-detail-date {
		color: var(--text-faint);
	}

	.evc-link-btn {
		font-size: 0.75em;
		font-weight: 500;
		padding: 2px 8px;
		cursor: pointer;
		background: var(--background-modifier-border);
		border-radius: 4px;
		color: var(--text-muted);
		border: none;
		line-height: inherit;
	}

	.evc-link-btn:hover {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	.evc-section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.evc-section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.evc-section-title {
		font-weight: 600;
		font-size: 1em;
	}

	.evc-empty-inline {
		color: var(--text-muted);
		font-size: 0.9em;
		padding: 8px 0;
	}

	.evc-badge {
		font-size: 0.75em;
		padding: 2px 8px;
		border-radius: 4px;
		font-weight: 500;
		background: var(--background-modifier-border);
		color: var(--text-muted);
	}

	.evc-badge-public {
		background: hsla(120, 40%, 50%, 0.15);
		color: var(--text-success, #22863a);
	}

	.evc-badge-private {
		background: var(--background-modifier-border);
	}

	.evc-badge-protected {
		background: hsla(45, 80%, 50%, 0.15);
		color: var(--text-warning, #b08800);
	}

	/* Local Folder Connection */
	.evc-connection-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 12px;
		background: var(--background-secondary);
		border-radius: 6px;
		gap: 12px;
	}

	.evc-connection-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.evc-connection-path {
		font-weight: 500;
		word-break: break-all;
	}

	.evc-connection-status {
		font-size: 0.85em;
		color: var(--text-muted);
	}

	/* Members */
	.evc-member-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.evc-member-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		background: var(--background-secondary);
		border-radius: 6px;
	}

	.evc-member-info {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.evc-member-email {
		font-weight: 500;
	}

	.evc-member-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.evc-role-select {
		font-size: 0.85em;
		padding: 2px 24px 2px 6px;
		min-width: 80px;
	}

	.evc-add-member {
		display: flex;
		gap: 6px;
		align-items: center;
		margin-top: 4px;
	}

	.evc-add-member input {
		flex: 1;
	}

	/* Invites */
	.evc-invite-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.evc-invite-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		background: var(--background-secondary);
		border-radius: 6px;
	}

	.evc-invite-invalid {
		opacity: 0.6;
	}

	.evc-invite-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.evc-invite-role {
		font-weight: 500;
		font-size: 0.9em;
	}

	.evc-invite-desc {
		font-size: 0.8em;
		color: var(--text-muted);
	}

	.evc-invite-actions {
		display: flex;
		gap: 6px;
	}

	/* Settings rows */
	.evc-setting-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 0;
		border-bottom: 1px solid var(--background-modifier-border);
		gap: 12px;
	}

	.evc-setting-row:last-child {
		border-bottom: none;
	}

	.evc-setting-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
	}

	.evc-setting-desc {
		font-size: 0.85em;
		color: var(--text-muted);
	}

	.evc-setting-actions {
		display: flex;
		gap: 6px;
	}

	.evc-slug-edit {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.evc-slug-edit input {
		width: 160px;
	}

	/* Buttons */
	.evc-small-btn {
		font-size: 0.85em;
		padding: 4px 10px;
	}

	.evc-btn-danger {
		color: var(--text-error);
		border-color: var(--text-error);
	}

	.evc-btn-danger:hover {
		background: var(--text-error);
		color: var(--text-on-accent);
	}
</style>
