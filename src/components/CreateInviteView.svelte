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

	// "can read" and "can edit" are what a person picks. The wire still calls
	// them viewer and editor, because that is the control plane's word and not
	// ours to change, and it stops here: no screen in this plugin says role,
	// viewer or editor (docs/ui-ux.md, "The words").
	let canEdit = true;
	$: role = canEdit ? "editor" : "viewer";
	let expiresInDays = "7";
	let maxUses = "";
	let creating = false;

	async function handleCreate() {
		const maxUsesNum = maxUses.trim() ? parseInt(maxUses.trim(), 10) : null;
		if (maxUsesNum !== null && (isNaN(maxUsesNum) || maxUsesNum < 1)) {
			new Notice("That has to be a whole number, one or more.");
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

			new Notice("Link ready. Send it to whoever should have it.");
			dispatch("created");
		} catch (e: unknown) {
			new Notice(
				`Could not make the link: ${e instanceof Error ? e.message : "Unknown error"}`,
			);
		} finally {
			creating = false;
		}
	}
</script>

<div class="evc-create-invite">
	<div class="evc-section-title">Invite somebody to {share.path}</div>
	<div class="evc-section-desc">
		You get a link to send them. Anyone who opens it joins this folder.
	</div>

	<div class="evc-form-field">
		<label for="evc-invite-access">What they can do</label>
		<select id="evc-invite-access" class="dropdown" bind:value={canEdit}>
			<option value={true}>Can edit</option>
			<option value={false}>Can read</option>
		</select>
		<p class="evc-field-note">
			{canEdit
				? "They can open these notes and change them, and you will see their edits as they type."
				: "They can open these notes. Nothing they do changes what you have."}
		</p>
	</div>

	<div class="evc-form-field">
		<label for="evc-invite-expiry">The link stops working after</label>
		<select id="evc-invite-expiry" class="dropdown" bind:value={expiresInDays}>
			<option value="7">7 days</option>
			<option value="14">14 days</option>
			<option value="30">30 days</option>
			<option value="0">Never</option>
		</select>
	</div>

	<div class="evc-form-field">
		<label for="evc-invite-maxuses">How many people can use it</label>
		<input
			id="evc-invite-maxuses"
			type="number"
			min="1"
			placeholder="As many as you send it to"
			bind:value={maxUses}
		/>
	</div>

	<div class="evc-form-actions">
		<button class="mod-cta" on:click={handleCreate} disabled={creating}>
			{creating ? "Making the link" : "Make a link"}
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

	.evc-field-note {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--text-muted);
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
