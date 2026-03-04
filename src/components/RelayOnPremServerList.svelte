<script lang="ts">
	import { Notice } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import { EVC_SERVER_ID, generateServerId, validateServerConfig } from "../RelayOnPremConfig";
	import { RelayOnPremLoginModal } from "../ui/RelayOnPremLoginModal";
	import { customFetch } from "../customFetch";
	import { confirmDialog } from "../ui/dialogs";

	export let plugin: Live;

	const dispatch = createEventDispatcher<{
		serversChanged: void;
		openShares: { server: RelayOnPremServer };
		openBilling: { server: RelayOnPremServer };
	}>();

	const relayOnPremSettings = plugin.relayOnPremSettings;

	// Subscribe to settings
	let settings = $relayOnPremSettings;
	$: settings = $relayOnPremSettings;
	$: servers = settings.servers || [];
	$: defaultServerId = settings.defaultServerId;

	// Editing state
	let editingServer: RelayOnPremServer | null = null;
	let isAddingServer = false;

	// New server form
	let newServerName = "";
	let newControlPlaneUrl = "";
	let newRelayServerUrl = "";
	let formError = "";

	// Testing state
	let testingServerId: string | null = null;

	// Track which servers support billing (enterprise + billing_enabled)
	let serverBillingSupport: Record<string, boolean> = {};

	// Refresh key to force auth status recalculation
	let authRefreshKey = 0;

	function getAuthStatus(serverId: string, _refreshKey: number): { isLoggedIn: boolean; email?: string } {
		const lm = plugin.loginManager;
		if (!lm || typeof lm.isLoggedInToServer !== "function") {
			return { isLoggedIn: false };
		}
		const isLoggedIn = lm.isLoggedInToServer(serverId);
		const msam = lm.getMultiServerAuthManager?.();
		const user = msam?.getUserForServer?.(serverId);
		return { isLoggedIn, email: user?.email };
	}

	function refreshAuthStatus() {
		authRefreshKey = authRefreshKey + 1;
		dispatch("serversChanged");
	}

	// Check billing support for all servers on load
	async function checkBillingSupport() {
		for (const s of servers) {
			if (serverBillingSupport[s.id] !== undefined) continue;
			const info = await fetchServerInfo(s.controlPlaneUrl);
			if (info) {
				serverBillingSupport[s.id] = info.edition === "enterprise" && info.features?.billing_enabled === true;
				serverBillingSupport = serverBillingSupport; // trigger reactivity
			}
		}
	}

	// Run on component init
	import { onMount } from "svelte";
	onMount(() => { checkBillingSupport(); });

	function startAddServer() {
		isAddingServer = true;
		editingServer = null;
		newServerName = "";
		newControlPlaneUrl = "";
		newRelayServerUrl = "";
		formError = "";
	}

	function startEditServer(server: RelayOnPremServer) {
		editingServer = { ...server };
		isAddingServer = false;
		newServerName = server.name;
		newControlPlaneUrl = server.controlPlaneUrl;
		newRelayServerUrl = server.relayServerUrl || "";
		formError = "";
	}

	function cancelEdit() {
		isAddingServer = false;
		editingServer = null;
		formError = "";
	}

	interface ServerFeatures {
		multi_user: boolean;
		share_members: boolean;
		audit_logging: boolean;
		admin_ui: boolean;
		oauth_enabled?: boolean;
		oauth_provider?: string | null;
		billing_enabled?: boolean;
	}

	interface ServerInfo {
		id: string;
		name: string;
		version: string;
		relay_url: string;
		edition?: string;
		features: ServerFeatures;
	}

	async function fetchServerInfo(url: string): Promise<ServerInfo | null> {
		try {
			console.log("[RelayOnPrem] Fetching server info from:", `${url}/server/info`);
			const response = await customFetch(`${url}/server/info`, { method: "GET" });
			console.log("[RelayOnPrem] Server info response status:", response.status);
			if (response.ok) {
				const data = await response.json();
				console.log("[RelayOnPrem] Server info data:", data);
				return data;
			} else {
				console.warn("[RelayOnPrem] Server info failed with status:", response.status);
			}
		} catch (error: unknown) {
			// Server info endpoint might not exist on older servers
			console.error("[RelayOnPrem] Server info fetch error:", error);
		}
		return null;
	}

	async function testConnection(url: string, serverId?: string) {
		if (serverId) {
			testingServerId = serverId;
		}
		try {
			const response = await customFetch(`${url}/health`, { method: "GET" });
			if (response.ok) {
				new Notice("Connection successful!");
				return true;
			} else {
				new Notice(`Connection failed: ${response.status}`);
				return false;
			}
		} catch (error: unknown) {
			new Notice(`Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`);
			return false;
		} finally {
			testingServerId = null;
		}
	}

	async function saveServer() {
		formError = "";

		// Validate inputs
		if (!newControlPlaneUrl.trim()) {
			formError = "Control Plane URL is required";
			return;
		}

		// Test connection first
		const connectionOk = await testConnection(newControlPlaneUrl.trim());
		if (!connectionOk) {
			formError = "Cannot connect to server";
			return;
		}

		// Try to fetch server info for auto-configuration
		const serverInfo = await fetchServerInfo(newControlPlaneUrl.trim());

		// Use server info or fallback to user input
		const serverName = newServerName.trim() || serverInfo?.name || new URL(newControlPlaneUrl).hostname;
		const relayUrl = newRelayServerUrl.trim() || serverInfo?.relay_url || undefined;

		// Generate or use existing ID (prefer server's own ID if available)
		const serverId = editingServer?.id || serverInfo?.id || generateServerId(newControlPlaneUrl);

		const serverConfig: RelayOnPremServer = {
			id: serverId,
			name: serverName,
			controlPlaneUrl: newControlPlaneUrl.trim(),
			relayServerUrl: relayUrl,
			isValidated: true,
			lastValidated: Date.now(),
			lastUserEmail: editingServer?.lastUserEmail,
		};

		// Validate server config
		const validation = validateServerConfig(serverConfig);
		if (!validation.valid) {
			formError = validation.errors.join(", ");
			return;
		}

		// Update settings
		await relayOnPremSettings.update((current) => {
			const newServers = [...(current.servers || [])];

			if (editingServer) {
				// Update existing
				const index = newServers.findIndex((s) => s.id === editingServer!.id);
				if (index >= 0) {
					newServers[index] = serverConfig;
				}
			} else {
				// Add new
				newServers.push(serverConfig);
			}

			// If this is the first server, make it default
			const newDefaultServerId =
				current.defaultServerId || (newServers.length === 1 ? serverConfig.id : current.defaultServerId);

			return {
				...current,
				servers: newServers,
				defaultServerId: newDefaultServerId,
			};
		});

		// Update LoginManager
		if (editingServer) {
			plugin.loginManager.updateServer(serverConfig);
		} else {
			plugin.loginManager.addServer(serverConfig);
		}

		cancelEdit();
		dispatch("serversChanged");
		new Notice(editingServer ? "Server updated" : "Server added");
	}

	async function removeServer(serverId: string) {
		const server = servers.find((s) => s.id === serverId);
		if (!server) return;

		// Confirm removal
		if (!(await confirmDialog(plugin.app, `Remove server "${server.name}"? This will also log you out from this server.`))) {
			return;
		}

		// Remove from settings
		await relayOnPremSettings.update((current) => {
			const newServers = current.servers.filter((s) => s.id !== serverId);
			const newDefaultServerId =
				current.defaultServerId === serverId
					? newServers.length > 0
						? newServers[0].id
						: undefined
					: current.defaultServerId;

			return {
				...current,
				servers: newServers,
				defaultServerId: newDefaultServerId,
			};
		});

		// Remove from LoginManager
		plugin.loginManager.removeServer(serverId);

		dispatch("serversChanged");
		new Notice(`Server "${server.name}" removed`);
	}

	async function loginToServer(server: RelayOnPremServer) {
		// First, fetch server info to check if OAuth is enabled
		const serverInfo = await fetchServerInfo(server.controlPlaneUrl);
		console.log("[RelayOnPrem] Server info:", serverInfo);

		// Track billing support for this server
		if (serverInfo) {
			serverBillingSupport[server.id] = serverInfo.edition === "enterprise" && serverInfo.features?.billing_enabled === true;
		}

		// If OAuth is enabled, try OAuth-first flow
		if (serverInfo?.features?.oauth_enabled && serverInfo.features.oauth_provider) {
			console.log("[RelayOnPrem] OAuth enabled, provider:", serverInfo.features.oauth_provider);

			const authProvider = plugin.loginManager.getAuthProviderForServer(server.id);
			console.log("[RelayOnPrem] Auth provider for server:", server.id, "exists:", !!authProvider);

			if (authProvider) {
				try {
					new Notice(`Starting OAuth login with ${serverInfo.features.oauth_provider}...`);
					await authProvider.loginWithOAuth2(serverInfo.features.oauth_provider);
					new Notice(`Logged in to ${server.name}`);
					refreshAuthStatus();
					return;
				} catch (error: unknown) {
					// OAuth failed, fall back to password login
					console.error("[RelayOnPrem] OAuth login failed:", error);
					new Notice(`OAuth failed: ${error instanceof Error ? error.message : "Unknown error"}. Falling back to password.`);
				}
			} else {
				console.warn("[RelayOnPrem] No auth provider found for server:", server.id);
				new Notice("Auth provider not ready. Please try again.");
			}
		}

		// Show password login modal (default or fallback)
		const modal = new RelayOnPremLoginModal(
			plugin.app,
			plugin.loginManager,
			() => {
				new Notice(`Logged in to ${server.name}`);
				refreshAuthStatus();
			},
			server.id
		);
		modal.open();
	}

	async function logoutFromServer(serverId: string) {
		try {
			await plugin.loginManager.logoutFromServer(serverId);
			new Notice("Logged out");
			refreshAuthStatus();
		} catch (error: unknown) {
			new Notice(`Logout failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	function openSharesForServer(server: RelayOnPremServer) {
		dispatch('openShares', { server });
	}

	async function toggleDefaultServer(serverId: string, isCurrentlyDefault: boolean) {
		if (isCurrentlyDefault) {
			// Unset default
			await relayOnPremSettings.update((current) => ({
				...current,
				defaultServerId: undefined,
			}));
			new Notice("Default server cleared");
		} else {
			// Set as default
			await relayOnPremSettings.update((current) => ({
				...current,
				defaultServerId: serverId,
			}));
			new Notice("Default server set");
		}
		dispatch("serversChanged");
	}
</script>

<div class="relay-server-list">
	{#if servers.length === 0 && !isAddingServer}
		<div class="relay-server-empty">
			<p>No relay servers configured. Add a server to get started.</p>
		</div>
	{/if}

	{#each servers as server (server.id)}
		{@const authStatus = getAuthStatus(server.id, authRefreshKey)}
		<div class="relay-server-item" class:is-default={server.id === defaultServerId}>
			<div class="relay-server-info">
				<div class="relay-server-name">
					<span class="relay-status-dot" class:is-connected={authStatus.isLoggedIn}></span>
					{server.name}
					{#if server.id === defaultServerId}
						<span class="relay-server-badge default">Default</span>
					{/if}
				</div>
				<div class="relay-server-url">{server.controlPlaneUrl}</div>
				{#if authStatus.isLoggedIn && authStatus.email}
					<div class="relay-server-user">As: {authStatus.email}</div>
				{/if}
			</div>
			<div class="relay-server-actions">
				{#if authStatus.isLoggedIn}
					<button class="relay-server-btn" on:click={() => logoutFromServer(server.id)}>
						Logout
					</button>
				{:else}
					<button class="relay-server-btn mod-cta" on:click={() => loginToServer(server)}>
						Login
					</button>
				{/if}
				<button
					class="relay-server-btn"
					on:click={() => testConnection(server.controlPlaneUrl, server.id)}
					disabled={testingServerId === server.id}
				>
					{testingServerId === server.id ? "..." : "Test"}
				</button>
				{#if authStatus.isLoggedIn}
					<button class="relay-server-btn" on:click={() => openSharesForServer(server)}>
						Shares
					</button>
					{#if serverBillingSupport[server.id]}
						<button class="relay-server-btn" on:click={() => dispatch('openBilling', { server })}>
							Plan & Usage
						</button>
					{/if}
				{/if}
				<button class="relay-server-btn" on:click={() => startEditServer(server)}>
					Edit
				</button>
				{#if server.id !== EVC_SERVER_ID}
					<button class="relay-server-btn mod-warning" on:click={() => removeServer(server.id)}>
						Remove
					</button>
				{/if}
			</div>
			<div class="relay-server-default">
				<label class="relay-default-checkbox">
					<input
						type="checkbox"
						checked={server.id === defaultServerId}
						on:change={() => toggleDefaultServer(server.id, server.id === defaultServerId)}
					/>
					<span>Default</span>
				</label>
			</div>
		</div>
	{/each}

	{#if isAddingServer || editingServer}
		<div class="relay-server-form">
			<h4>{editingServer ? "Edit Server" : "Add Server"}</h4>

			<div class="relay-server-form-field">
				<label for="control-plane-url">Control Plane URL</label>
				<input
					id="control-plane-url"
					type="text"
					placeholder="https://cp.example.com"
					bind:value={newControlPlaneUrl}
				/>
			</div>

			<div class="relay-server-form-field">
				<label for="server-name">Server Name (auto-detected if empty)</label>
				<input
					id="server-name"
					type="text"
					placeholder="Leave empty to auto-detect"
					bind:value={newServerName}
				/>
			</div>

			<div class="relay-server-form-field">
				<label for="relay-server-url">Relay Server URL (auto-detected if empty)</label>
				<input
					id="relay-server-url"
					type="text"
					placeholder="Leave empty to auto-detect"
					bind:value={newRelayServerUrl}
				/>
			</div>

			{#if formError}
				<div class="relay-server-form-error">{formError}</div>
			{/if}

			<div class="relay-server-form-actions">
				<button class="mod-cta" on:click={saveServer}>
					{editingServer ? "Save Changes" : "Add Server"}
				</button>
				<button on:click={cancelEdit}>Cancel</button>
			</div>
		</div>
	{:else}
		<button class="relay-server-add-btn" on:click={startAddServer}>
			+ Add Server
		</button>
	{/if}
</div>

<style>
	.relay-server-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.relay-server-empty {
		padding: 20px;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--background-modifier-border);
		border-radius: 6px;
	}

	.relay-server-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px;
		background: var(--background-secondary);
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
	}

	.relay-server-item.is-default {
		border-color: var(--interactive-accent);
	}

	.relay-server-info {
		flex: 1;
		min-width: 0;
	}

	.relay-server-name {
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.relay-status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
		flex-shrink: 0;
	}

	.relay-status-dot.is-connected {
		background: var(--color-green, #28a745);
	}

	.relay-server-badge {
		font-size: 0.75em;
		padding: 2px 6px;
		border-radius: 4px;
		font-weight: 500;
	}

	.relay-server-badge.default {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
	}

	.relay-server-url {
		font-size: 0.85em;
		color: var(--text-muted);
		word-break: break-all;
		margin-top: 4px;
	}

	.relay-server-user {
		font-size: 0.85em;
		color: var(--text-muted);
		margin-top: 2px;
	}

	.relay-server-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-left: 12px;
	}

	.relay-server-btn {
		padding: 4px 8px;
		font-size: 0.85em;
		cursor: pointer;
	}

	.relay-server-form {
		padding: 16px;
		background: var(--background-secondary);
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
	}

	.relay-server-form h4 {
		margin: 0 0 12px 0;
	}

	.relay-server-form-field {
		margin-bottom: 12px;
	}

	.relay-server-form-field label {
		display: block;
		margin-bottom: 4px;
		font-size: 0.9em;
		color: var(--text-muted);
	}

	.relay-server-form-field input {
		width: 100%;
	}

	.relay-server-form-error {
		color: var(--text-error);
		font-size: 0.9em;
		margin-bottom: 12px;
	}

	.relay-server-form-actions {
		display: flex;
		gap: 8px;
	}

	.relay-server-add-btn {
		padding: 12px;
		background: var(--background-secondary);
		border: 1px dashed var(--background-modifier-border);
		border-radius: 6px;
		cursor: pointer;
		color: var(--text-muted);
		transition: all 0.15s ease;
	}

	.relay-server-add-btn:hover {
		background: var(--background-secondary-alt);
		color: var(--text-normal);
	}

	.relay-server-default {
		margin-left: 12px;
		display: flex;
		align-items: center;
	}

	.relay-default-checkbox {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.85em;
		color: var(--text-muted);
		cursor: pointer;
	}

	.relay-default-checkbox input {
		margin: 0;
		cursor: pointer;
	}

	.relay-default-checkbox input:checked + span {
		color: var(--interactive-accent);
		font-weight: 500;
	}
</style>
