<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { Notice } from "obsidian";
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import type { ShareWithServer } from "../RelayOnPremShareClientManager";
	import type { AgentKey, RelayOnPremShare } from "../RelayOnPremShareClient";

	export let plugin: Live;
	export let server: RelayOnPremServer;
	export let initialShare: ShareWithServer | null = null;

	// Data
	let shares: RelayOnPremShare[] = [];
	let keysByShare: Record<string, AgentKey[]> = {};
	let loadingShares = true;

	// Create modal state
	let showCreateModal = false;
	let newKeyLabel = "";
	let newKeyShareId = "";
	let newKeyExpiryChoice = "never";
	let creating = false;
	let createError: string | null = null;
	let createNeeds401Reauth = false;

	// Reveal modal state
	let revealedKey: { key: string; label: string; shareId: string; shareName: string; expiresAt: string | null } | null = null;
	let revealCopied = false;
	let revealCloseWarning = false;

	// Revoke confirm state
	let revokeTarget: { key: AgentKey; shareId: string } | null = null;

	// Visibility change handler ref
	let visibilityHandler: () => void;

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	function timeAgo(dateStr: string): string {
		const now = Date.now();
		const then = new Date(dateStr).getTime();
		if (isNaN(then)) return dateStr;
		const diffMs = now - then;
		const diffSec = Math.floor(diffMs / 1000);
		const diffMin = Math.floor(diffSec / 60);
		const diffHour = Math.floor(diffMin / 60);
		const diffDay = Math.floor(diffHour / 24);
		const diffMonth = Math.floor(diffDay / 30);
		if (diffSec < 60) return "just now";
		if (diffMin < 60) return `${diffMin} min ago`;
		if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
		if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
		return `${diffMonth} month${diffMonth === 1 ? "" : "s"} ago`;
	}

	function expiryChoiceToIso(choice: string): string | undefined {
		if (choice === "never") return undefined;
		const now = new Date();
		if (choice === "30d") now.setDate(now.getDate() + 30);
		else if (choice === "90d") now.setDate(now.getDate() + 90);
		else if (choice === "1y") now.setFullYear(now.getFullYear() + 1);
		else return undefined;
		return now.toISOString();
	}

	function downloadKey(key: string, label: string, expiresAt: string | null): void {
		const content = [
			`Agent Key: ${label}`,
			`Key: ${key}`,
			expiresAt ? `Expires: ${expiresAt}` : "Expires: Never",
			`Downloaded: ${new Date().toISOString()}`,
		].join("\n");
		const blob = new Blob([content], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `agent-key-${label.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.txt`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	function checkSessionFreshness(): boolean {
		try {
			const provider =
				plugin.loginManager.getMultiServerAuthManager?.()?.getProvider(server.id) ??
				plugin.loginManager.getAuthProvider?.();
			if (!provider) return true;
			const token = (provider as any).getToken?.() ?? (provider as any).token ?? null;
			if (!token || typeof token !== "string") return true;
			const parts = token.split(".");
			if (parts.length !== 3) return true;
			const payload = JSON.parse(atob(parts[1]));
			const iat: number = payload.iat ?? 0;
			const ageMs = Date.now() - iat * 1000;
			return ageMs <= 120 * 1000; // fresh if within 120 seconds (spec requirement)
		} catch {
			return true; // don't block user on decode failure
		}
	}

	// -------------------------------------------------------------------------
	// Data loading
	// -------------------------------------------------------------------------

	async function loadSharesAndKeys() {
		loadingShares = true;
		try {
			// Get all shares for this server
			let allShares: RelayOnPremShare[] = [];
			const client =
				plugin.shareClientManager?.getClient?.(server.id) ??
				plugin.shareClient ?? null;
			if (client) {
				allShares = await client.listShares();
			}

			// Get current user to filter to owned shares
			const multiServerAuth = plugin.loginManager.getMultiServerAuthManager?.();
			const currentUser = multiServerAuth
				? multiServerAuth.getUserForServer?.(server.id)
				: plugin.loginManager.getAuthProvider?.()?.getCurrentUser?.();

			const ownedShares = currentUser
				? allShares.filter((s) => s.owner_user_id === currentUser.id)
				: allShares;

			shares = ownedShares;

			// Load keys per share in parallel
			const newKeysByShare: Record<string, AgentKey[]> = {};
			await Promise.all(
				ownedShares.map(async (share) => {
					try {
						let keys: AgentKey[] = [];
						if (plugin.shareClientManager) {
							keys = await plugin.shareClientManager.listAgentKeys(server.id, share.id);
						} else if (plugin.shareClient) {
							keys = await plugin.shareClient.listAgentKeys(share.id);
						}
						newKeysByShare[share.id] = keys;
					} catch {
						newKeysByShare[share.id] = [];
					}
				}),
			);

			keysByShare = newKeysByShare;
		} finally {
			loadingShares = false;
		}
	}

	// -------------------------------------------------------------------------
	// Create modal
	// -------------------------------------------------------------------------

	async function openCreateModal(preselectedShareId?: string) {
		const fresh = checkSessionFreshness();
		if (!fresh) {
			try {
				await plugin.loginManager.reAuthForSensitiveAction(server.id);
			} catch (e: unknown) {
				new Notice(`Re-authentication failed: ${e instanceof Error ? e.message : "Unknown error"}`);
				return;
			}
		}
		newKeyLabel = "";
		newKeyShareId = preselectedShareId ?? initialShare?.id ?? shares[0]?.id ?? "";
		newKeyExpiryChoice = "never";
		createError = null;
		createNeeds401Reauth = false;
		showCreateModal = true;
	}

	async function createKey() {
		if (!newKeyLabel.trim()) return;
		creating = true;
		createError = null;
		createNeeds401Reauth = false;
		try {
			const expiresAt = expiryChoiceToIso(newKeyExpiryChoice);
			const request = {
				label: newKeyLabel.trim(),
				...(expiresAt ? { expires_at: expiresAt } : {}),
			};
			let response;
			if (plugin.shareClientManager) {
				response = await plugin.shareClientManager.createAgentKey(server.id, newKeyShareId, request);
			} else if (plugin.shareClient) {
				response = await plugin.shareClient.createAgentKey(newKeyShareId, request);
			}
			if (response) {
				const shareName = shares.find((s) => s.id === newKeyShareId)?.path ?? newKeyShareId;
				revealedKey = {
					key: response.key,
					label: response.label,
					shareId: newKeyShareId,
					shareName,
					expiresAt: response.expires_at ?? null,
				};
				revealCopied = false;
				revealCloseWarning = false;
				showCreateModal = false;
				await loadSharesAndKeys();
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
				createNeeds401Reauth = true;
				createError = "Session expired. Please re-authenticate and try again.";
			} else {
				createError = `Failed to create key: ${msg}`;
			}
		} finally {
			creating = false;
		}
	}

	// -------------------------------------------------------------------------
	// Revoke
	// -------------------------------------------------------------------------

	async function confirmRevoke() {
		if (!revokeTarget) return;
		const { key, shareId } = revokeTarget;

		// Optimistic removal
		const prev = [...(keysByShare[shareId] ?? [])];
		keysByShare = { ...keysByShare, [shareId]: prev.filter((k) => k.id !== key.id) };

		revokeTarget = null;

		try {
			if (plugin.shareClientManager) {
				await plugin.shareClientManager.revokeAgentKey(server.id, shareId, key.id);
			} else if (plugin.shareClient) {
				await plugin.shareClient.revokeAgentKey(shareId, key.id);
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("404")) {
				new Notice("Share removed — key inactive");
			} else {
				// Restore key on failure
				keysByShare = { ...keysByShare, [shareId]: prev };
				new Notice(`Failed to revoke key: ${msg}`);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Reveal modal handlers
	// -------------------------------------------------------------------------

	function handleRevealClose() {
		if (!revealCloseWarning) {
			revealCloseWarning = true;
			return;
		}
		revealedKey = null;
		revealCloseWarning = false;
	}

	function dismissRevealedKey() {
		revealedKey = null;
		revealCloseWarning = false;
	}

	function copyRevealedKey() {
		if (!revealedKey) return;
		navigator.clipboard.writeText(revealedKey.key).then(() => {
			revealCopied = true;
			setTimeout(() => { revealCopied = false; }, 2000);
		}).catch(() => {
			new Notice("Failed to copy key");
		});
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	onMount(async () => {
		await loadSharesAndKeys();
		visibilityHandler = () => {
			if (!document.hidden) loadSharesAndKeys();
		};
		document.addEventListener("visibilitychange", visibilityHandler);
	});

	onDestroy(() => {
		if (visibilityHandler) {
			document.removeEventListener("visibilitychange", visibilityHandler);
		}
	});
</script>

<!-- Main view -->
<div class="ak-view">
	<div class="ak-header-row">
		<h3 class="ak-title">Agent Keys</h3>
		<button class="evc-small-btn mod-cta" on:click={() => openCreateModal()}>+ Create agent key</button>
	</div>

	{#if loadingShares}
		<div class="ak-state-msg">Loading...</div>
	{:else if shares.length === 0}
		<div class="ak-state-msg ak-empty">
			No shares found for this server. Create a share first to manage agent keys.
		</div>
	{:else}
		{#each shares as share (share.id)}
			<div class="ak-share-group">
				<div class="ak-share-header">
					<span class="ak-share-path">{share.path}</span>
					<button class="evc-small-btn" on:click={() => openCreateModal(share.id)}>+ Create key</button>
				</div>
				{#if (keysByShare[share.id] ?? []).length === 0}
					<div class="ak-no-keys">No keys for this share.</div>
				{:else}
					<table class="ak-table">
						<thead>
							<tr>
								<th>Label</th>
								<th>Created</th>
								<th>Expires</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each (keysByShare[share.id] ?? []) as key (key.id)}
								<tr>
									<td class="ak-label">{key.label}</td>
									<td title={key.created_at}>{timeAgo(key.created_at)}</td>
									<td>{key.expires_at ? new Date(key.expires_at).toLocaleDateString() : "Never"}</td>
									<td>
										<button
											class="evc-small-btn evc-btn-danger"
											on:click={() => { revokeTarget = { key, shareId: share.id }; }}
										>
											Revoke
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</div>
		{/each}
	{/if}
</div>

<!-- Create modal -->
{#if showCreateModal}
	<div class="ak-overlay" role="presentation" on:click|self={() => {}}>
		<div class="ak-modal" role="dialog" aria-modal="true" on:click|stopPropagation>
			<div class="ak-modal-header">
				<span class="ak-modal-title">Create agent key</span>
				<button class="ak-close-btn" on:click={() => { showCreateModal = false; }}>✕</button>
			</div>

			<div class="ak-modal-body">
				<div class="ak-field">
					<label for="ak-label-input">Label</label>
					<input
						id="ak-label-input"
						type="text"
						placeholder="e.g. ci-bot"
						bind:value={newKeyLabel}
						required
						disabled={creating}
						on:keydown={(e) => { if (e.key === "Enter" && newKeyLabel.trim()) createKey(); }}
					/>
				</div>

				{#if initialShare}
					<div class="ak-field">
						<label>Share</label>
						<span class="ak-static-share">{initialShare.path}</span>
					</div>
				{:else}
					<div class="ak-field">
						<label for="ak-share-select">Share</label>
						<select id="ak-share-select" bind:value={newKeyShareId} disabled={creating}>
							{#each shares as s (s.id)}
								<option value={s.id}>{s.path}</option>
							{/each}
						</select>
					</div>
				{/if}

				<div class="ak-field">
					<label for="ak-expiry-select">Expiry</label>
					<select id="ak-expiry-select" bind:value={newKeyExpiryChoice} disabled={creating}>
						<option value="never">Never</option>
						<option value="30d">30 days</option>
						<option value="90d">90 days</option>
						<option value="1y">1 year</option>
					</select>
				</div>

				{#if createError}
					<div class="ak-error-banner">
						{createError}
						{#if createNeeds401Reauth}
							<button class="evc-small-btn ak-reauth-btn" on:click={async () => {
								try {
									await plugin.loginManager.reAuthForSensitiveAction(server.id);
									createError = null;
									createNeeds401Reauth = false;
								} catch (e: unknown) {
									new Notice(`Re-auth failed: ${e instanceof Error ? e.message : "error"}`);
								}
							}}>Re-authenticate</button>
						{/if}
					</div>
				{/if}
			</div>

			<div class="ak-modal-footer">
				<button class="evc-small-btn" on:click={() => { showCreateModal = false; }} disabled={creating}>Cancel</button>
				<button
					class="evc-small-btn mod-cta"
					on:click={createKey}
					disabled={creating || !newKeyLabel.trim()}
				>
					{creating ? "Creating..." : "Create key"}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Reveal modal -->
{#if revealedKey}
	<div class="ak-overlay" role="presentation" on:click|self={() => {}}>
		<div class="ak-modal" role="dialog" aria-modal="true" on:click|stopPropagation>
			<div class="ak-modal-header">
				<span class="ak-modal-title">Key created: {revealedKey.label}</span>
				<button class="ak-close-btn" on:click={handleRevealClose} title="Close">✕</button>
			</div>

			{#if revealCloseWarning}
				<div class="ak-warn-banner">You haven't copied the key yet. Click ✕ again to close anyway.</div>
			{/if}

			<div class="ak-modal-body">
				<p class="ak-reveal-warning">Save this key — it will <strong>not</strong> be shown again.</p>

				<code class="ak-key-block">{revealedKey.key}</code>

				<div class="ak-reveal-actions">
					<button class="evc-small-btn" on:click={copyRevealedKey}>
						{revealCopied ? "Copied!" : "Copy"}
					</button>
					<button class="evc-small-btn" on:click={() => downloadKey(revealedKey!.key, revealedKey!.label, revealedKey!.expiresAt)}>
						Download .txt
					</button>
				</div>

				<div class="ak-reveal-meta">
					<span>Share: {revealedKey.shareName}</span>
					{#if revealedKey.expiresAt}
						<span>Expires: {new Date(revealedKey.expiresAt).toLocaleString()}</span>
					{:else}
						<span>Expires: Never</span>
					{/if}
				</div>
			</div>

			<div class="ak-modal-footer">
				<button class="evc-small-btn mod-cta" on:click={dismissRevealedKey}>
					I've copied this key — close
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Revoke confirm modal -->
{#if revokeTarget}
	<div class="ak-overlay" role="presentation" on:click|self={() => {}}>
		<div class="ak-modal" role="dialog" aria-modal="true" on:click|stopPropagation>
			<div class="ak-modal-header">
				<span class="ak-modal-title">Revoke key?</span>
			</div>
			<div class="ak-modal-body">
				<p>Revoke <strong>{revokeTarget.key.label}</strong>? This cannot be undone — any agent using this key will lose access immediately.</p>
			</div>
			<div class="ak-modal-footer">
				<button class="evc-small-btn" on:click={() => { revokeTarget = null; }}>Cancel</button>
				<button class="evc-small-btn evc-btn-danger" on:click={confirmRevoke}>Revoke key</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Main view */
	.ak-view {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.ak-header-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.ak-title {
		margin: 0;
		font-size: 1.1em;
		font-weight: 600;
	}

	.ak-state-msg {
		color: var(--text-muted);
		font-size: 0.9em;
		padding: 12px 0;
	}

	.ak-empty {
		font-style: italic;
	}

	/* Share groups */
	.ak-share-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		background: var(--background-secondary);
		border-radius: 6px;
	}

	.ak-share-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.ak-share-path {
		font-weight: 600;
		font-size: 0.95em;
		word-break: break-all;
	}

	.ak-no-keys {
		color: var(--text-muted);
		font-size: 0.85em;
	}

	/* Keys table */
	.ak-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85em;
	}

	.ak-table th {
		text-align: left;
		color: var(--text-muted);
		font-weight: 500;
		padding: 4px 6px 4px 0;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.ak-table td {
		padding: 6px 6px 6px 0;
		vertical-align: middle;
	}

	.ak-label {
		font-weight: 500;
	}

	/* Overlay + modal */
	.ak-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.ak-modal {
		background: var(--background-primary);
		border-radius: 8px;
		padding: 20px;
		max-width: 440px;
		width: 90%;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.ak-modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.ak-modal-title {
		font-weight: 600;
		font-size: 1em;
	}

	.ak-close-btn {
		background: none;
		border: none;
		cursor: pointer;
		padding: 2px 6px;
		color: var(--text-muted);
		font-size: 1em;
		line-height: 1;
		box-shadow: none;
	}

	.ak-close-btn:hover {
		color: var(--text-normal);
	}

	.ak-modal-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.ak-modal-footer {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}

	/* Form fields */
	.ak-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.ak-field label {
		font-size: 0.85em;
		color: var(--text-muted);
		font-weight: 500;
	}

	.ak-field input,
	.ak-field select {
		width: 100%;
	}

	.ak-static-share {
		font-size: 0.9em;
		color: var(--text-normal);
		padding: 4px 0;
	}

	/* Error / warning banners */
	.ak-error-banner {
		padding: 10px 12px;
		background: rgba(var(--color-red-rgb, 220, 50, 50), 0.1);
		border: 1px solid rgba(var(--color-red-rgb, 220, 50, 50), 0.3);
		border-radius: 4px;
		font-size: 0.85em;
		color: var(--color-red, #dc3232);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.ak-reauth-btn {
		align-self: flex-start;
	}

	.ak-warn-banner {
		padding: 8px 12px;
		background: rgba(180, 120, 0, 0.1);
		border: 1px solid rgba(180, 120, 0, 0.3);
		border-radius: 4px;
		font-size: 0.85em;
		color: var(--text-warning, #b08800);
	}

	/* Reveal modal */
	.ak-reveal-warning {
		margin: 0;
		font-size: 0.9em;
	}

	.ak-key-block {
		display: block;
		padding: 10px 12px;
		background: var(--background-secondary);
		border-radius: 4px;
		font-family: monospace;
		font-size: 0.85em;
		word-break: break-all;
		user-select: all;
	}

	.ak-reveal-actions {
		display: flex;
		gap: 8px;
	}

	.ak-reveal-meta {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.8em;
		color: var(--text-muted);
	}

	/* Shared button styles */
	.evc-small-btn {
		font-size: 0.85em;
		padding: 4px 10px;
		cursor: pointer;
	}

	.evc-btn-danger {
		color: var(--color-red, var(--text-error));
		border-color: var(--color-red, var(--text-error));
	}

	.evc-btn-danger:hover {
		background: var(--color-red, var(--text-error));
		color: var(--text-on-accent, white);
	}
</style>
