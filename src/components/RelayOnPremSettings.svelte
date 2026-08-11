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
	<!-- The header is a title and a line of description. The link row that used
	     to sit under it (documentation, MCP server, mesh) and the icon buttons
	     beside it all led off this screen, which is not what somebody opened
	     settings to do. -->
	<div class="evc-settings-header">
		<div class="evc-header-top">
			<div class="evc-header-text">
				<div class="evc-header-title">Knap Sync</div>
				<div class="evc-header-desc">Your vault on a server you host yourself</div>
			</div>
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
					<div class="evc-section-heading-title">Knap servers</div>
					<div class="evc-section-heading-desc">
						The servers this vault syncs with. Open one to sign in, test it or
						change its address.
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

	/* Header */
	.evc-settings-header {
		padding: 16px 20px;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.evc-header-top {
		display: flex;
		align-items: center;
		gap: 14px;
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
