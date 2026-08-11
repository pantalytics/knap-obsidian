<script lang="ts">
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import type { ShareWithServer } from "../RelayOnPremShareClientManager";
	import SignIn from "./SignIn.svelte";
	import ShareListView from "./ShareListView.svelte";
	import ShareDetailView from "./ShareDetailView.svelte";
	import CreateShareView from "./CreateShareView.svelte";
	import CreateInviteView from "./CreateInviteView.svelte";
	import AgentKeysView from "./AgentKeysView.svelte";
	import Breadcrumbs from "./Breadcrumbs.svelte";

	export let plugin: Live;

	// Navigation state. "home" is the sign-in screen, and everything else is
	// reached from it once somebody is signed in.
	type ViewType = "home" | "shares" | "shareDetail" | "createShare" | "createInvite" | "agentKeys";
	let currentView: ViewType = "home";
	let selectedServer: RelayOnPremServer | null = null;
	let selectedShare: ShareWithServer | null = null;

	// Navigation functions
	function navigateTo(view: ViewType) {
		currentView = view;
		if (view === "home") {
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

	// Signing out drops back to the sign-in screen: everything past it needs
	// an account, and a stale share list is worse than no share list.
	function handleSignedOut() {
		selectedServer = null;
		selectedShare = null;
		currentView = "home";
	}

	// Breadcrumb items
	$: breadcrumbItems = getBreadcrumbs(currentView, selectedServer, selectedShare);

	function getBreadcrumbs(view: ViewType, server: RelayOnPremServer | null, share: ShareWithServer | null) {
		const items: any[] = [
			{ type: "home", onClick: () => navigateTo("home") },
		];

		if (server && view !== "home") {
			items.push({
				type: "text",
				text: server.name,
				onClick: () => navigateTo("shares"),
			});
		}

		if (view === "createShare") {
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
				<div class="evc-header-desc">Your vault on Knap, on every device you use</div>
			</div>
		</div>
	</div>

	<!-- Breadcrumb Navigation -->
	{#if currentView !== "home"}
		<div class="evc-breadcrumb-bar">
			<Breadcrumbs items={breadcrumbItems} element="div" />
		</div>
	{/if}

	<!-- Content Area -->
	<div class="evc-settings-content">
		{#if currentView === "home"}
			<SignIn
				{plugin}
				on:openShares={handleOpenShares}
				on:signedOut={handleSignedOut}
			/>
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
</style>
