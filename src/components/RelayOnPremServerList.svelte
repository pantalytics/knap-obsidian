<script lang="ts">
	import { Notice } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import {
		KNAP_SERVER_ID,
		generateServerId,
		validateServerConfig,
		findDuplicateServer,
		isServerVersionSupported,
		serverCompatMessage,
	} from "../RelayOnPremConfig";
	import { RelayOnPremLoginModal } from "../ui/RelayOnPremLoginModal";
	import { customFetch } from "../customFetch";
	import { confirmDialog } from "../ui/dialogs";

	// The row has two states and no third one: closed is a dot, a name and
	// where it stands; open is everything you can do to it, editing included.
	// Opening the row IS editing it, so there is no separate Edit button to
	// press and no second panel to get lost in. Same shape as the servers
	// screen in Knap's own panel, on purpose: a person who has seen one of
	// these has seen both.

	export let plugin: Live;

	const dispatch = createEventDispatcher<{
		serversChanged: void;
		openShares: { server: RelayOnPremServer };
		openBilling: { server: RelayOnPremServer };
		openAgentKeys: { server: RelayOnPremServer };
	}>();

	const relayOnPremSettings = plugin.relayOnPremSettings;

	// Subscribe to settings
	let settings = $relayOnPremSettings;
	$: settings = $relayOnPremSettings;
	$: servers = settings.servers || [];
	$: defaultServerId = settings.defaultServerId;

	// Which row is open. One at a time: two open rows is a list of forms.
	let openServerId: string | null = null;
	let isAddingServer = false;

	// The open row's fields, and the add form's. Only one of the two is on
	// screen at a time, so they share the same three variables.
	let formName = "";
	let formControlPlaneUrl = "";
	let formRelayServerUrl = "";
	let formError = "";

	// Testing state
	let testingServerId: string | null = null;

	// Track which servers support billing (enterprise + billing_enabled)
	let serverBillingSupport: Record<string, boolean> = {};

	// Refresh key to force auth status recalculation
	let authRefreshKey = 0;

	function getAuthStatus(
		serverId: string,
		_refreshKey: number,
	): { isLoggedIn: boolean; email?: string } {
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
				serverBillingSupport[s.id] =
					info.edition === "enterprise" &&
					info.features?.billing_enabled === true;
				serverBillingSupport = serverBillingSupport; // trigger reactivity
			}
		}
	}

	// Run on component init
	onMount(() => {
		checkBillingSupport();
	});

	function toggleServer(server: RelayOnPremServer) {
		if (openServerId === server.id) {
			openServerId = null;
			formError = "";
			return;
		}
		isAddingServer = false;
		openServerId = server.id;
		formName = server.name;
		formControlPlaneUrl = server.controlPlaneUrl;
		formRelayServerUrl = server.relayServerUrl || "";
		formError = "";
	}

	function startAddServer() {
		isAddingServer = true;
		openServerId = null;
		formName = "";
		formControlPlaneUrl = "";
		formRelayServerUrl = "";
		formError = "";
	}

	function cancelAdd() {
		isAddingServer = false;
		formError = "";
	}

	// Whether the open row's fields still match what is saved. Save stays
	// disabled until they do not, so the button never asks for a round trip
	// that would change nothing.
	$: openServer = servers.find((s) => s.id === openServerId) || null;
	$: isDirty = openServer
		? formName.trim() !== openServer.name ||
			formControlPlaneUrl.trim() !== openServer.controlPlaneUrl ||
			formRelayServerUrl.trim() !== (openServer.relayServerUrl || "")
		: false;

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
			new Notice(
				`Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			return false;
		} finally {
			testingServerId = null;
		}
	}

	async function saveServer(existing: RelayOnPremServer | null) {
		formError = "";

		// Validate inputs
		if (!formControlPlaneUrl.trim()) {
			formError = "The server address is required";
			return;
		}

		// Test connection first
		const connectionOk = await testConnection(formControlPlaneUrl.trim());
		if (!connectionOk) {
			formError = "Cannot connect to server";
			return;
		}

		// Try to fetch server info for auto-configuration
		const serverInfo = await fetchServerInfo(formControlPlaneUrl.trim());

		// TR-57: reject a server below this plugin's compatibility floor here,
		// at connect time — otherwise it saves fine and only fails later with
		// confusing unversioned 404s on whichever endpoint the server predates.
		// Only block on a CONCRETE version we know is too old — fetchServerInfo()
		// returns null both for "server predates this endpoint" and for a plain
		// network hiccup (it already succeeded a /health check moments ago via
		// testConnection above), and conflating those would false-block saving
		// an already-compatible server on a transient blip. A server that
		// genuinely never returns a version is a rarer, softer case than the
		// audit's actual finding (version fetched but not checked) — not
		// hard-blocked here, same as before this fix.
		if (serverInfo?.version && !isServerVersionSupported(serverInfo.version)) {
			formError = serverCompatMessage(serverInfo.version);
			return;
		}

		// Use server info or fallback to user input
		const serverName =
			formName.trim() || serverInfo?.name || new URL(formControlPlaneUrl).hostname;
		const relayUrl = formRelayServerUrl.trim() || serverInfo?.relay_url || undefined;

		// Generate or use existing ID (prefer server's own ID if available)
		const serverId = existing?.id || serverInfo?.id || generateServerId(formControlPlaneUrl);

		// Reject adding a server that duplicates an existing one (same id or
		// same URL under a different id) — editing an existing entry is exempt,
		// it's expected to keep its own id.
		if (!existing) {
			const duplicate = findDuplicateServer(servers, serverId, formControlPlaneUrl);
			if (duplicate) {
				formError = `"${duplicate.name}" already uses this address. Open that server instead of adding a second one.`;
				return;
			}
		}

		const serverConfig: RelayOnPremServer = {
			id: serverId,
			name: serverName,
			controlPlaneUrl: formControlPlaneUrl.trim(),
			relayServerUrl: relayUrl,
			isValidated: true,
			lastValidated: Date.now(),
			lastUserEmail: existing?.lastUserEmail,
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

			if (existing) {
				// Update existing
				const index = newServers.findIndex((s) => s.id === existing.id);
				if (index >= 0) {
					newServers[index] = serverConfig;
				}
			} else {
				// Add new
				newServers.push(serverConfig);
			}

			// If this is the first server, make it default
			const newDefaultServerId =
				current.defaultServerId ||
				(newServers.length === 1 ? serverConfig.id : current.defaultServerId);

			return {
				...current,
				servers: newServers,
				defaultServerId: newDefaultServerId,
			};
		});

		// Update LoginManager
		if (existing) {
			plugin.loginManager.updateServer(serverConfig);
		} else {
			plugin.loginManager.addServer(serverConfig);
		}

		isAddingServer = false;
		formError = "";
		// A saved row stays open on the server it just wrote, so whatever came
		// next (signing in, testing) is still under the hand that saved it.
		openServerId = existing ? serverConfig.id : null;
		dispatch("serversChanged");
		new Notice(existing ? "Server updated" : "Server added");
	}

	async function removeServer(serverId: string) {
		const server = servers.find((s) => s.id === serverId);
		if (!server) return;

		// Confirm removal
		if (
			!(await confirmDialog(
				plugin.app,
				`Remove server "${server.name}"? This will also log you out from this server.`,
			))
		) {
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

		if (openServerId === serverId) openServerId = null;
		dispatch("serversChanged");
		new Notice(`Server "${server.name}" removed`);
	}

	async function loginToServer(server: RelayOnPremServer) {
		// First, fetch server info to check if OAuth is enabled
		const serverInfo = await fetchServerInfo(server.controlPlaneUrl);
		console.log("[RelayOnPrem] Server info:", serverInfo);

		// Track billing support for this server
		if (serverInfo) {
			serverBillingSupport[server.id] =
				serverInfo.edition === "enterprise" &&
				serverInfo.features?.billing_enabled === true;
		}

		// If OAuth is enabled, try OAuth-first flow. TR-27: OAuthCallbackServer
		// needs the Electron desktop app (Node's http module) — on mobile this
		// attempt is doomed before it starts, and would flash a technical
		// "OAuth failed: ... only supported on the desktop app" Notice before
		// falling back. Skip straight to the password modal instead, which
		// already explains SSO isn't available on mobile.
		if (serverInfo?.features?.oauth_enabled && serverInfo.features.oauth_provider) {
			console.log(
				"[RelayOnPrem] OAuth enabled, provider:",
				serverInfo.features.oauth_provider,
			);

			const authProvider = plugin.loginManager.getAuthProviderForServer(server.id);
			console.log(
				"[RelayOnPrem] Auth provider for server:",
				server.id,
				"exists:",
				!!authProvider,
			);

			if (authProvider) {
				try {
					new Notice(`Starting OAuth login with ${serverInfo.features.oauth_provider}...`);
					// Route through LoginManager (not the authProvider directly) so
					// this.user gets set and notifyListeners() fires — see TR-10,
					// #e7bca9fb — otherwise main.ts's post-login hook never runs and
					// shares/live-sync don't start until the plugin is reloaded.
					await plugin.loginManager.loginWithOAuth2(
						serverInfo.features.oauth_provider,
						server.id,
					);
					new Notice(`Logged in to ${server.name}`);
					refreshAuthStatus();
					return;
				} catch (error: unknown) {
					// OAuth failed, fall back to password login
					console.error("[RelayOnPrem] OAuth login failed:", error);
					new Notice(
						`OAuth failed: ${error instanceof Error ? error.message : "Unknown error"}. Falling back to password.`,
					);
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
			server.id,
		);
		modal.open();
	}

	async function logoutFromServer(serverId: string) {
		try {
			await plugin.loginManager.logoutFromServer(serverId);
			new Notice("Logged out");
			refreshAuthStatus();
		} catch (error: unknown) {
			new Notice(
				`Logout failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	function openSharesForServer(server: RelayOnPremServer) {
		dispatch("openShares", { server });
	}

	// The closed row says which server it is without being opened, and the
	// scheme is noise there: everything here is https and nobody is choosing
	// between two of the same host.
	function shortHost(url: string): string {
		return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
	}

	async function makeDefault(serverId: string) {
		await relayOnPremSettings.update((current) => ({
			...current,
			defaultServerId: serverId,
		}));
		new Notice("Default server set");
		dispatch("serversChanged");
	}
</script>

<div class="knap-server-list">
	{#each servers as server (server.id)}
		{@const authStatus = getAuthStatus(server.id, authRefreshKey)}
		{@const isOpen = openServerId === server.id}
		{@const isTesting = testingServerId === server.id}
		<div class="knap-server-card" class:is-open={isOpen}>
			<button
				type="button"
				class="knap-server-head"
				aria-expanded={isOpen}
				on:click={() => toggleServer(server)}
			>
				<span
					class="knap-dot"
					class:is-on={authStatus.isLoggedIn}
					class:is-busy={isTesting}
				></span>
				<span class="knap-server-name">{server.name}</span>
				<span class="knap-server-host">{shortHost(server.controlPlaneUrl)}</span>
				{#if servers.length > 1 && server.id === defaultServerId}
					<span class="knap-chip">Default</span>
				{/if}
				<span class="knap-server-state" class:is-on={authStatus.isLoggedIn}>
					{#if isTesting}
						Testing
					{:else if authStatus.isLoggedIn}
						{authStatus.email || "Signed in"}
					{:else}
						Not signed in
					{/if}
				</span>
				<svg
					class="knap-chev"
					class:is-open={isOpen}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M19 9l-7 7-7-7" />
				</svg>
			</button>

			{#if isOpen}
				<div class="knap-server-body">
					<div class="knap-actions">
						{#if authStatus.isLoggedIn}
							<button class="knap-btn" on:click={() => logoutFromServer(server.id)}>
								Sign out
							</button>
						{:else}
							<button class="knap-btn mod-cta" on:click={() => loginToServer(server)}>
								Sign in
							</button>
						{/if}
						<button
							class="knap-btn"
							on:click={() => testConnection(server.controlPlaneUrl, server.id)}
							disabled={isTesting}
						>
							{isTesting ? "Testing" : "Test"}
						</button>
						{#if authStatus.isLoggedIn}
							<button class="knap-btn" on:click={() => openSharesForServer(server)}>
								Shares
							</button>
							{#if serverBillingSupport[server.id]}
								<button class="knap-btn" on:click={() => dispatch("openBilling", { server })}>
									Plan and usage
								</button>
							{/if}
							<button class="knap-btn" on:click={() => dispatch("openAgentKeys", { server })}>
								Agent keys
							</button>
						{/if}
					</div>

					<div class="knap-fields">
						<div class="knap-field">
							<label for="cp-url-{server.id}">Server address</label>
							<input
								id="cp-url-{server.id}"
								type="text"
								placeholder="https://cp.example.com"
								bind:value={formControlPlaneUrl}
							/>
						</div>
						<div class="knap-field">
							<label for="name-{server.id}">Name</label>
							<input
								id="name-{server.id}"
								type="text"
								placeholder="Leave empty to use the server's own name"
								bind:value={formName}
							/>
						</div>
						<div class="knap-field">
							<label for="relay-url-{server.id}">Sync address</label>
							<input
								id="relay-url-{server.id}"
								type="text"
								placeholder="Leave empty and the server will say where to sync"
								bind:value={formRelayServerUrl}
							/>
						</div>

						{#if formError}
							<div class="knap-form-error">{formError}</div>
						{/if}

						<button
							class="knap-btn"
							class:mod-cta={isDirty}
							disabled={!isDirty}
							on:click={() => saveServer(server)}
						>
							Save changes
						</button>
					</div>

					<div class="knap-server-footer">
						{#if server.id === defaultServerId}
							<span class="knap-footer-note">Used by default for new shares</span>
						{:else}
							<button class="knap-link-btn" on:click={() => makeDefault(server.id)}>
								Make default
							</button>
						{/if}
						{#if server.id !== KNAP_SERVER_ID}
							<button class="knap-link-btn is-warning" on:click={() => removeServer(server.id)}>
								Remove
							</button>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/each}

	{#if isAddingServer}
		<div class="knap-server-card is-open">
			<div class="knap-server-body knap-add-form">
				<div class="knap-fields">
					<div class="knap-field">
						<label for="new-cp-url">Server address</label>
						<input
							id="new-cp-url"
							type="text"
							placeholder="https://cp.example.com"
							bind:value={formControlPlaneUrl}
						/>
					</div>
					<div class="knap-field">
						<label for="new-name">Name</label>
						<input
							id="new-name"
							type="text"
							placeholder="Leave empty to use the server's own name"
							bind:value={formName}
						/>
					</div>
					<div class="knap-field">
						<label for="new-relay-url">Sync address</label>
						<input
							id="new-relay-url"
							type="text"
							placeholder="Leave empty and the server will say where to sync"
							bind:value={formRelayServerUrl}
						/>
					</div>

					{#if formError}
						<div class="knap-form-error">{formError}</div>
					{/if}

					<div class="knap-actions">
						<button class="knap-btn mod-cta" on:click={() => saveServer(null)}>
							Add server
						</button>
						<button class="knap-btn" on:click={cancelAdd}>Cancel</button>
					</div>
				</div>
			</div>
		</div>
	{:else}
		<!-- The dashed button is the empty state. A paragraph explaining the
		     absence of a row would be saying the same thing twice. -->
		<button class="knap-add-btn" on:click={startAddServer}> + Add server </button>
	{/if}
</div>

<style>
	.knap-server-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.knap-server-card {
		border: 1px solid var(--background-modifier-border);
		border-radius: var(--radius-m, 8px);
		background: var(--background-secondary);
		overflow: hidden;
	}

	.knap-server-card.is-open {
		border-color: var(--background-modifier-border-hover, var(--background-modifier-border));
	}

	/* Closed row: a dot, a name, where it stands, a chevron. */
	.knap-server-head {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 12px 14px;
		background: transparent;
		border: none;
		border-radius: 0;
		box-shadow: none;
		text-align: left;
		cursor: pointer;
		font-size: var(--font-ui-small, 13px);
	}

	.knap-server-head:hover {
		background: var(--background-modifier-hover);
	}

	.knap-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faint);
		flex: none;
	}

	.knap-dot.is-on {
		background: var(--color-green, #28a745);
	}

	.knap-dot.is-busy {
		background: var(--interactive-accent);
		animation: knap-pulse 1.2s ease-in-out infinite;
	}

	@keyframes knap-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}

	.knap-server-name {
		font-weight: 600;
		color: var(--text-normal);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.knap-server-host {
		color: var(--text-muted);
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.knap-chip {
		flex: none;
		padding: 1px 6px;
		border-radius: var(--radius-s, 4px);
		background: var(--background-modifier-border);
		color: var(--text-muted);
		font-size: 10px;
		font-weight: 500;
	}

	.knap-server-state {
		margin-left: auto;
		flex: none;
		color: var(--text-muted);
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 45%;
	}

	.knap-chev {
		flex: none;
		width: 16px;
		height: 16px;
		color: var(--text-faint);
		transition: transform 0.15s ease;
	}

	.knap-chev.is-open {
		transform: rotate(180deg);
	}

	/* Open row: the facts, then everything you can do to it. */
	.knap-server-body {
		border-top: 1px solid var(--background-modifier-border);
		padding: 12px 14px 14px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.knap-add-form {
		border-top: none;
	}

	.knap-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.knap-btn {
		padding: 4px 10px;
		font-size: 12px;
		cursor: pointer;
	}

	.knap-btn:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.knap-fields {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: 12px;
		border-top: 1px solid var(--background-modifier-border);
	}

	.knap-add-form .knap-fields {
		padding-top: 0;
		border-top: none;
	}

	.knap-field label {
		display: block;
		margin-bottom: 4px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.knap-field input {
		width: 100%;
	}

	.knap-form-error {
		color: var(--text-error);
		font-size: 12px;
	}

	.knap-fields > .knap-btn {
		align-self: flex-start;
	}

	.knap-server-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--background-modifier-border);
	}

	.knap-footer-note {
		font-size: 12px;
		color: var(--text-muted);
	}

	.knap-link-btn {
		padding: 0;
		background: transparent;
		border: none;
		box-shadow: none;
		font-size: 12px;
		color: var(--text-muted);
		cursor: pointer;
	}

	.knap-link-btn:hover {
		background: transparent;
		color: var(--text-normal);
	}

	.knap-link-btn.is-warning:hover {
		color: var(--text-error);
	}

	.knap-add-btn {
		padding: 12px;
		background: transparent;
		border: 1px dashed var(--background-modifier-border);
		border-radius: var(--radius-m, 8px);
		box-shadow: none;
		cursor: pointer;
		color: var(--text-muted);
		font-size: 13px;
		transition:
			color 0.15s ease,
			border-color 0.15s ease;
	}

	.knap-add-btn:hover {
		background: transparent;
		border-color: var(--text-muted);
		color: var(--text-normal);
	}
</style>
