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
	import Breadcrumbs from "./Breadcrumbs.svelte";
	import evcLogo from "../assets/evc-logo.png";

	export let plugin: Live;

	// Refresh key — incremented on login/logout via serversChanged event
	let authRefreshKey = 0;

	const EVC_URL = "https://github.com/entire-vc";

	// Navigation state
	type ViewType = "servers" | "shares" | "shareDetail" | "createShare" | "createInvite" | "billing";
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
		} else if (share && (view === "shareDetail")) {
			items.push({ type: "text", text: share.path });
		}

		return items;
	}
</script>

<div class="evc-relay-settings">
	<!-- Static Header -->
	<div class="evc-settings-header">
		<div class="evc-header-left">
			<a href={EVC_URL} class="evc-header-brand" target="_blank" rel="noopener noreferrer">
				<img src={evcLogo} alt="EVC Logo" class="evc-header-logo" />
				<div class="evc-header-text">
					<div class="evc-header-title">EVC Team Relay</div>
					<div class="evc-header-desc">
						Self-hosted relay for real-time collaboration
					</div>
				</div>
			</a>
			<div class="evc-quick-links">
				<a href="https://github.com/entire-vc/evc-team-relay-obsidian-plugin/issues/new?template=bug-report.yml" class="evc-pill-btn" target="_blank" rel="noopener noreferrer">
					<svg class="evc-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
					Bug report
				</a>
				<a href="https://github.com/entire-vc/evc-team-relay-obsidian-plugin/issues/new?template=feature-request.yml" class="evc-pill-btn" target="_blank" rel="noopener noreferrer">
					<svg class="evc-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>
					Feature request
				</a>
				<a href="https://github.com/entire-vc/evc-team-relay-obsidian-plugin/issues/new?template=web-publish.yml" class="evc-pill-btn" target="_blank" rel="noopener noreferrer">
					<svg class="evc-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
					Web publish issue
				</a>
			</div>
		</div>
		<a
			href={EVC_URL}
			class="evc-github-badge"
			target="_blank"
			rel="noopener noreferrer"
			title="Visit Entire VC on GitHub"
		>
			<svg class="evc-github-icon" viewBox="0 0 16 16" fill="currentColor">
				<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
			</svg>
			<span class="evc-github-text">GitHub</span>
		</a>
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
				<RelayOnPremServerList {plugin} on:openShares={handleOpenShares} on:openBilling={handleOpenBilling} on:serversChanged={() => { authRefreshKey++; }} />
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
		{/if}
	</div>
</div>

<style>
	.evc-relay-settings {
		padding: 0;
	}

	/* Header */
	.evc-settings-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid var(--background-modifier-border);
		margin-bottom: 0;
	}

	.evc-header-left {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.evc-header-brand {
		display: flex;
		align-items: center;
		gap: 12px;
		text-decoration: none;
		color: inherit;
		transition: opacity 0.15s;
	}

	.evc-header-brand:hover {
		opacity: 0.85;
	}

	.evc-header-logo {
		width: 44px;
		height: 44px;
		border-radius: 10px;
	}

	.evc-header-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.evc-header-title {
		font-weight: 700;
		font-size: 1.3em;
		color: var(--text-normal);
	}

	.evc-header-desc {
		color: var(--text-muted);
		font-size: 0.85em;
	}

	.evc-github-badge {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border: 1px solid var(--background-modifier-border);
		border-radius: 16px;
		text-decoration: none;
		color: var(--text-normal);
		font-size: 0.85em;
		font-weight: 500;
		transition: all 0.15s;
	}

	.evc-github-badge:hover {
		border-color: var(--text-muted);
		background: var(--background-modifier-hover);
	}

	.evc-github-icon {
		width: 16px;
		height: 16px;
	}

	/* Quick Links (pill buttons) */
	.evc-quick-links {
		display: flex;
		gap: 8px;
		padding-left: 56px;
		flex-wrap: wrap;
	}

	.evc-pill-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 12px;
		border: 1px solid var(--background-modifier-border);
		border-radius: 16px;
		font-size: 0.8em;
		color: var(--text-normal);
		text-decoration: none;
		transition: all 0.15s;
		white-space: nowrap;
	}

	.evc-pill-btn:hover {
		border-color: var(--text-muted);
		background: var(--background-modifier-hover);
	}

	.evc-pill-icon {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
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
