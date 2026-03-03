<script lang="ts">
	import { Notice } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type Live from "../main";
	import type { Invite } from "../RelayOnPremShareClient";
	import type { ShareWithServer } from "../RelayOnPremShareClientManager";

	export let plugin: Live;
	export let share: ShareWithServer;

	const dispatch = createEventDispatcher<{
		created: void;
		cancel: void;
	}>();

	let role: "viewer" | "editor" = "editor";
	let expiresInDays = "7";
	let maxUses = "";
	let creating = false;

	async function handleCreate() {
		const maxUsesNum = maxUses.trim() ? parseInt(maxUses.trim(), 10) : null;
		if (maxUsesNum !== null && (isNaN(maxUsesNum) || maxUsesNum < 1)) {
			new Notice("Max uses must be a positive number");
			return;
		}

		const days = parseInt(expiresInDays, 10);

		creating = true;
		try {
			if (plugin.shareClientManager) {
				await plugin.shareClientManager.createInvite(
					share.serverId,
					share.id,
					{
						role,
						expires_in_days: days === 0 ? null : days,
						max_uses: maxUsesNum,
					},
				);
			} else if (plugin.shareClient) {
				await plugin.shareClient.createInvite(share.id, {
					role,
					expires_in_days: days === 0 ? null : days,
					max_uses: maxUsesNum,
				});
			} else {
				throw new Error("No share client available");
			}

			new Notice("Invite link created!");
			dispatch("created");
		} catch (e: unknown) {
			new Notice(`Failed to create invite: ${e instanceof Error ? e.message : "Unknown error"}`);
		} finally {
			creating = false;
		}
	}
</script>

<div class="evc-create-invite">
	<div class="evc-section-title">Create Invite Link</div>
	<div class="evc-section-desc">for {share.path}</div>

	<div class="evc-form-field">
		<label for="evc-invite-role">Role</label>
		<select id="evc-invite-role" class="dropdown" bind:value={role}>
			<option value="viewer">Viewer</option>
			<option value="editor">Editor</option>
		</select>
	</div>

	<div class="evc-form-field">
		<label for="evc-invite-expiry">Expiration</label>
		<select id="evc-invite-expiry" class="dropdown" bind:value={expiresInDays}>
			<option value="7">7 days</option>
			<option value="14">14 days</option>
			<option value="30">30 days</option>
			<option value="0">No expiration</option>
		</select>
	</div>

	<div class="evc-form-field">
		<label for="evc-invite-maxuses">Max Uses (optional)</label>
		<input
			id="evc-invite-maxuses"
			type="number"
			min="1"
			placeholder="Unlimited"
			bind:value={maxUses}
		/>
	</div>

	<div class="evc-form-actions">
		<button class="mod-cta" on:click={handleCreate} disabled={creating}>
			{creating ? "Creating..." : "Create Invite Link"}
		</button>
		<button on:click={() => dispatch('cancel')}>Cancel</button>
	</div>
</div>

<style>
	.evc-create-invite {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.evc-section-title {
		font-weight: 600;
		font-size: 1.05em;
	}

	.evc-section-desc {
		font-size: 0.85em;
		color: var(--text-muted);
		margin-top: -8px;
	}

	.evc-form-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.evc-form-field label {
		font-size: 0.9em;
		color: var(--text-muted);
		font-weight: 500;
	}

	.evc-form-field input,
	.evc-form-field select {
		width: 100%;
	}

	.evc-form-actions {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}
</style>
