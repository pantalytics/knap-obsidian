<script lang="ts">
	import { onMount } from "svelte";
	import { Notice } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import { getDefaultServer } from "../RelayOnPremConfig";
	import type { ShareWithServer } from "../RelayOnPremShareClientManager";
	import { RelayOnPremShareClientManager } from "../RelayOnPremShareClientManager";
	import { RelayOnPremShareClient } from "../RelayOnPremShareClient";

	export let plugin: Live;
	export let server: RelayOnPremServer;

	const dispatch = createEventDispatcher<{
		selectShare: { share: ShareWithServer };
		createShare: void;
	}>();

	let shares: ShareWithServer[] = [];
	let loading = true;
	let error: string | null = null;

	onMount(async () => {
		ensureShareClientsInitialized();
		await loadShares();
	});

	function ensureShareClientsInitialized() {
		const settings = plugin.relayOnPremSettings.get();
		if (plugin.shareClientManager) {
			for (const s of settings.servers) {
				if (!plugin.shareClientManager.getClient(s.id)) {
					plugin.shareClientManager.addServer(s);
				}
			}
			return;
		}
		if (settings.enabled && settings.servers.length > 0) {
			const multiServerAuth = plugin.loginManager.getMultiServerAuthManager();
			if (multiServerAuth) {
				plugin.shareClientManager = new RelayOnPremShareClientManager(
					multiServerAuth,
					settings.servers,
				);
				return;
			}
		}
		if (!plugin.shareClient && settings.enabled) {
			const defaultServer = getDefaultServer(settings);
			if (defaultServer && plugin.loginManager.getAuthProvider()) {
				plugin.shareClient = new RelayOnPremShareClient(
					defaultServer.controlPlaneUrl,
					async () => {
						const provider = plugin.loginManager.getAuthProvider();
						return provider ? await provider.getValidToken() : undefined;
					},
				);
			}
		}
	}

	async function loadShares() {
		loading = true;
		error = null;
		try {
			if (plugin.shareClientManager) {
				const rawShares = await plugin.shareClientManager.listShares(server.id);
				shares = rawShares.map(share => ({
					...share,
					serverId: server.id,
					serverName: server.name,
				}));
			} else if (plugin.shareClient) {
				const rawShares = await plugin.shareClient.listShares();
				shares = rawShares.map(share => ({
					...share,
					serverId: "default",
					serverName: "Default Server",
				}));
			} else {
				error = "Please add a server and log in first.";
			}
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : "Failed to load shares";
		} finally {
			loading = false;
		}
	}
</script>

<div class="evc-share-list">
	<div class="evc-share-list-header">
		<div class="evc-section-title">Shares on {server.name}</div>
		<button class="mod-cta" on:click={() => dispatch('createShare')}>
			Create Share
		</button>
	</div>

	{#if loading}
		<div class="evc-loading">Loading shares...</div>
	{:else if error}
		<div class="evc-error">{error}</div>
	{:else if shares.length === 0}
		<div class="evc-empty">
			<p>No shares yet. Create your first share to get started!</p>
		</div>
	{:else}
		<div class="evc-share-items">
			{#each shares as share (share.id)}
				<div
					class="evc-share-item"
					on:click={() => dispatch('selectShare', { share })}
					on:keypress={(e) => { if (e.key === 'Enter') dispatch('selectShare', { share }); }}
					role="button"
					tabindex="0"
				>
					<div class="evc-share-item-header">
						<span class="evc-share-item-name">{share.path}</span>
						<span class="evc-badge">{share.kind}</span>
					</div>
					<div class="evc-share-item-meta">
						<span class="evc-badge evc-badge-{share.visibility}">{share.visibility}</span>
						<span class="evc-share-item-date">
							{new Date(share.created_at).toLocaleDateString()}
						</span>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.evc-share-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.evc-share-list-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.evc-section-title {
		font-weight: 600;
		font-size: 1.05em;
	}

	.evc-loading,
	.evc-empty {
		padding: 24px;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--background-modifier-border);
		border-radius: 8px;
	}

	.evc-error {
		padding: 16px;
		color: var(--text-error);
		background: var(--background-modifier-error);
		border-radius: 8px;
	}

	.evc-share-items {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.evc-share-item {
		padding: 12px;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 8px;
		cursor: pointer;
		transition: border-color 0.15s ease;
	}

	.evc-share-item:hover {
		border-color: var(--interactive-accent);
	}

	.evc-share-item-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
	}

	.evc-share-item-name {
		font-weight: 600;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.evc-share-item-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 6px;
		font-size: 0.85em;
		color: var(--text-muted);
	}

	.evc-share-item-date {
		color: var(--text-faint);
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
		background: hsla(var(--color-green-hsl, 120 40% 50%), 0.15);
		color: var(--text-success, var(--color-green));
	}

	.evc-badge-private {
		background: var(--background-modifier-border);
	}

	.evc-badge-protected {
		background: hsla(var(--color-yellow-hsl, 45 80% 50%), 0.15);
		color: var(--text-warning, var(--color-yellow));
	}
</style>
