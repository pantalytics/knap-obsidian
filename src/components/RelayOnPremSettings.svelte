<script lang="ts">
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import type { ShareWithServer } from "../RelayOnPremShareClientManager";
	import RelayOnPremServerList from "./RelayOnPremServerList.svelte";
	import ShareListView from "./ShareListView.svelte";
	import ShareDetailView from "./ShareDetailView.svelte";
	import CreateShareView from "./CreateShareView.svelte";
	import CreateInviteView from "./CreateInviteView.svelte";
	import BillingView from "./BillingView.svelte";
	import AgentKeysView from "./AgentKeysView.svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";

	export let plugin: Live;

	// Refresh key — incremented on login/logout via serversChanged event
	let authRefreshKey = 0;

	const EVC_URL = "https://github.com/pantalytics/knap-obsidian";

	// Navigation state
	type ViewType = "servers" | "shares" | "shareDetail" | "createShare" | "createInvite" | "billing" | "agentKeys";
	let currentView: ViewType = "servers";
	let selectedServer: RelayOnPremServer | null = null;
	let selectedShare: ShareWithServer | null = null;

	// Navigation functions
	function navigateTo(view: ViewType) {
		currentView = view;
		if (view === "servers") {
			selectedServer = null;
			selectedShare = null;
		} else if (view === "shares") {
			selectedShare = null;
		}
	}

	function handleOpenShares(event: CustomEvent<{ server: RelayOnPremServer }>) {
		selectedServer = event.detail.server;
		selectedShare = null;
		currentView = "shares";
	}

	function handleOpenBilling(event: CustomEvent<{ server: RelayOnPremServer }>) {
		selectedServer = event.detail.server;
		selectedShare = null;
		currentView = "billing";
	}

	function handleSelectShare(event: CustomEvent<{ share: ShareWithServer }>) {
		selectedShare = event.detail.share;
		currentView = "shareDetail";
	}

	function handleShareCreated() {
		// Go back to shares list to see the new share
		currentView = "shares";
	}

	function handleShareDeleted() {
		selectedShare = null;
		currentView = "shares";
	}

	function handleCreateInviteDone() {
		// Go back to share detail to see the new invite
		currentView = "shareDetail";
	}

	function handleOpenAgentKeys() {
		currentView = "agentKeys";
	}

	function handleOpenServerAgentKeys(event: CustomEvent<{ server: RelayOnPremServer }>) {
		selectedServer = event.detail.server;
		selectedShare = null;
		currentView = "agentKeys";
	}

	// Breadcrumb items
	$: breadcrumbItems = getBreadcrumbs(currentView, selectedServer, selectedShare);

	function getBreadcrumbs(view: ViewType, server: RelayOnPremServer | null, share: ShareWithServer | null) {
		const items: any[] = [
			{ type: "home", onClick: () => navigateTo("servers") },
		];

		if (server && view !== "servers") {
			items.push({
				type: "text",
				text: server.name,
				onClick: () => navigateTo("shares"),
			});
		}

		if (view === "billing") {
			items.push({ type: "text", text: "Plan & Usage" });
		} else if (view === "createShare") {
			items.push({ type: "text", text: "Create Share" });
		} else if (view === "createInvite" && share) {
			items.push({
				type: "text",
				text: share.path,
				onClick: () => navigateTo("shareDetail"),
			});
			items.push({ type: "text", text: "Create Invite" });
		} else if (view === "agentKeys") {
			if (share) {
				items.push({
					type: "text",
					text: share.path,
					onClick: () => navigateTo("shareDetail"),
				});
			}
			items.push({ type: "text", text: "Agent Keys" });
		} else if (share && (view === "shareDetail")) {
			items.push({ type: "text", text: share.path });
		}

		return items;
	}
</script>

<div class="knap-sync-settings">
	<!-- Direction B — Native toolbar header -->
	<div class="evc-settings-header">
		<!-- Top row: logo + title/desc + ghost icon buttons -->
		<div class="evc-header-top">
			<div class="evc-header-text">
				<div class="evc-header-title">Knap Sync</div>
				<div class="evc-header-desc">Self-hosted relay for real-time collaboration</div>
			</div>
			<div class="evc-header-actions">
				<a class="evc-ghost-btn" href="https://github.com/entire-vc/knap-sync-obsidian-plugin?utm_source=obsidian-plugin&utm_medium=plugin-header&utm_campaign=teamrelay&utm_content=github" target="_blank" rel="noopener" title="GitHub">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 4 5 4 5 4c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 11c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
				</a>
				<a class="evc-ghost-btn" href="https://github.com/entire-vc/knap-sync-obsidian-plugin/issues/new?template=bug-report.yml&utm_source=obsidian-plugin&utm_medium=plugin-header&utm_campaign=teamrelay&utm_content=bug" target="_blank" rel="noopener" title="Bug report">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>
				</a>
				<a class="evc-ghost-btn" href="https://github.com/entire-vc/knap-sync-obsidian-plugin/issues/new?template=feature-request.yml&utm_source=obsidian-plugin&utm_medium=plugin-header&utm_campaign=teamrelay&utm_content=feature" target="_blank" rel="noopener" title="Feature request">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
				</a>
				<a class="evc-ghost-btn" href="https://github.com/entire-vc/knap-sync-obsidian-plugin/issues/new?template=web-publish.yml&utm_source=obsidian-plugin&utm_medium=plugin-header&utm_campaign=teamrelay&utm_content=webpublish" target="_blank" rel="noopener" title="Web publish issue">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
				</a>
			</div>
		</div>
		<!-- Bottom row: CTA buttons -->
		<div class="evc-header-ctas">
			<a class="evc-prim-btn" href="https://github.com/pantalytics/knap-obsidian" target="_blank" rel="noopener">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>
				Documentation
			</a>
			<a class="evc-prim-btn" href="https://github.com/pantalytics/knap-obsidian" target="_blank" rel="noopener">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/></svg>
				MCP server
			</a>
			<a class="evc-prim-btn evc-mesh-btn" href="https://github.com/pantalytics/knap-obsidian" target="_blank" rel="noopener">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
				Mesh
			</a>
		</div>
	</div>

	<!-- Breadcrumb Navigation -->
	{#if currentView !== "servers"}
		<div class="evc-breadcrumb-bar">
			<Breadcrumbs items={breadcrumbItems} element="div" />
		</div>
	{/if}

	<!-- Content Area -->
	<div class="evc-settings-content">
		{#if currentView === "servers"}
			<div class="evc-server-section">
				<div class="evc-section-heading">
					<div class="evc-section-heading-title">Relay Servers</div>
					<div class="evc-section-heading-desc">
						Configure your relay-onprem servers. Click "Shares" to manage shares.
					</div>
				</div>
				<RelayOnPremServerList {plugin} on:openShares={handleOpenShares} on:openBilling={handleOpenBilling} on:openAgentKeys={handleOpenServerAgentKeys} on:serversChanged={() => { authRefreshKey++; }} />
			</div>
		{:else if currentView === "shares" && selectedServer}
			<ShareListView
				{plugin}
				server={selectedServer}
				on:selectShare={handleSelectShare}
				on:createShare={() => { currentView = "createShare"; }}
			/>
		{:else if currentView === "shareDetail" && selectedServer && selectedShare}
			<ShareDetailView
				{plugin}
				server={selectedServer}
				share={selectedShare}
				on:createInvite={() => { currentView = "createInvite"; }}
				on:deleted={handleShareDeleted}
				on:agentKeys={handleOpenAgentKeys}
			/>
		{:else if currentView === "createShare" && selectedServer}
			<CreateShareView
				{plugin}
				server={selectedServer}
				on:created={handleShareCreated}
				on:cancel={() => navigateTo("shares")}
			/>
		{:else if currentView === "createInvite" && selectedServer && selectedShare}
			<CreateInviteView
				{plugin}
				share={selectedShare}
				on:created={handleCreateInviteDone}
				on:cancel={() => navigateTo("shareDetail")}
			/>
		{:else if currentView === "billing" && selectedServer}
			<BillingView
				{plugin}
				server={selectedServer}
			/>
		{:else if currentView === "agentKeys" && selectedServer}
			<AgentKeysView
				{plugin}
				server={selectedServer}
				initialShare={selectedShare}
			/>
		{/if}
	</div>
</div>

<style>
	.knap-sync-settings {
		padding: 0;
	}

	/* Header — Direction B (native toolbar) */
	.evc-settings-header {
		padding: 16px 20px;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.evc-header-top {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.evc-header-logo {
		width: 32px;
		height: 32px;
		border-radius: 7px;
		flex: none;
	}

	.evc-header-text {
		flex: 1;
		min-width: 0;
	}

	.evc-header-title {
		font-size: 17px;
		font-weight: 700;
		color: var(--text-normal);
		letter-spacing: -0.2px;
		line-height: 1.2;
	}

	.evc-header-desc {
		font-size: 13px;
		color: var(--text-muted);
		margin-top: 1px;
	}

	.evc-header-actions {
		display: flex;
		align-items: center;
		gap: 2px;
		flex: none;
	}

	.evc-ghost-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: var(--radius-s, 6px);
		color: var(--text-faint);
		text-decoration: none;
		transition: background 0.15s, color 0.15s;
	}

	.evc-ghost-btn:hover {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	.evc-ghost-btn svg {
		width: 16px;
		height: 16px;
	}

	/* CTA row */
	.evc-header-ctas {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--background-modifier-border);
		flex-wrap: wrap;
	}

	.evc-prim-btn {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 34px;
		padding: 0 14px;
		border-radius: var(--radius-s, 6px);
		background: rgba(124, 92, 255, 0.1);
		color: var(--interactive-accent);
		border: 1px solid rgba(124, 92, 255, 0.2);
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
		transition: background 0.15s;
	}

	.evc-prim-btn:hover {
		background: rgba(124, 92, 255, 0.18);
	}

	.evc-prim-btn svg {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}

	.evc-mesh-btn {
		background: rgba(0, 105, 106, 0.1);
		color: #00696a;
		border-color: rgba(0, 105, 106, 0.2);
	}

	.evc-mesh-btn:hover {
		background: rgba(0, 105, 106, 0.18);
	}

	/* Breadcrumbs */
	.evc-breadcrumb-bar {
		padding: 10px 20px;
		border-bottom: 1px solid var(--background-modifier-border);
		font-size: 0.9em;
	}

	/* Content */
	.evc-settings-content {
		padding: 16px 20px;
	}

	/* Server section heading */
	.evc-server-section {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.evc-section-heading {
		margin-bottom: 4px;
	}

	.evc-section-heading-title {
		font-weight: 600;
		font-size: 1.1em;
	}

	.evc-section-heading-desc {
		color: var(--text-muted);
		font-size: 0.9em;
		margin-top: 4px;
	}
</style>
