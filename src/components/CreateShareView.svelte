<script lang="ts">
	import { Notice } from "obsidian";
	import { createEventDispatcher } from "svelte";
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import { getDefaultServer } from "../RelayOnPremConfig";
	import type { RelayOnPremShare } from "../RelayOnPremShareClient";
	import { LimitExceededApiError } from "../RelayOnPremShareClient";
	import { FolderSuggestModal } from "../ui/FolderSuggestModal";
	import { S3RN } from "../S3RN";

	export let plugin: Live;
	export let server: RelayOnPremServer;

	const dispatch = createEventDispatcher<{
		created: { share: RelayOnPremShare };
		cancel: void;
	}>();

	let selectedPath = "";
	let kind: "doc" | "folder" = "folder";
	let visibility: "private" | "public" | "protected" = "private";
	let password = "";
	let creating = false;

	function choosePath() {
		const modal = new FolderSuggestModal(
			plugin.app,
			"Choose folder for share...",
			new Set(),
			plugin.sharedFolders,
			(folderPath: string) => {
				selectedPath = folderPath;
			},
		);
		modal.open();
	}

	async function handleCreate() {
		if (!selectedPath.trim()) {
			new Notice("Please select a folder path");
			return;
		}
		if (visibility === "protected" && !password.trim()) {
			new Notice("Password is required for protected shares");
			return;
		}

		creating = true;
		try {
			const createRequest = {
				path: selectedPath.trim(),
				kind,
				visibility,
				...(password.trim() && { password: password.trim() }),
			};

			let share: RelayOnPremShare;
			if (plugin.shareClientManager) {
				share = await plugin.shareClientManager.createShare(server.id, createRequest);
			} else if (plugin.shareClient) {
				share = await plugin.shareClient.createShare(createRequest);
			} else {
				throw new Error("No share client available");
			}

			// Create local SharedFolder for CRDT sync
			if (kind === "folder") {
				try {
					plugin.sharedFolders.new(share.path, share.id, "relay-onprem", false);
					plugin.folderNavDecorations?.quickRefresh();
				} catch (e: unknown) {
					console.error("[RelayOnPrem] Failed to create SharedFolder:", e);
				}
			}

			new Notice(`Share "${share.path}" created!`);
			dispatch("created", { share });
		} catch (e: unknown) {
			if (e instanceof LimitExceededApiError) {
				const info = e.limitInfo;
				new Notice(
					`Share limit reached (${info.current}/${info.max} on ${info.plan} plan). ` +
					`Upgrade your plan to create more shares.`,
					8000,
				);
			} else {
				new Notice(`Failed to create share: ${e instanceof Error ? e.message : "Unknown error"}`);
			}
		} finally {
			creating = false;
		}
	}
</script>

<div class="evc-create-share">
	<div class="evc-section-title">Create New Share</div>

	<div class="evc-form-field">
		<label for="evc-path-btn">Path</label>
		<div class="evc-path-selector">
			<button id="evc-path-btn" class="evc-path-btn" on:click={choosePath}>
				{selectedPath || "Choose folder..."}
			</button>
		</div>
	</div>

	<div class="evc-form-field">
		<label for="evc-kind">Type</label>
		<select id="evc-kind" class="dropdown" bind:value={kind}>
			<option value="doc">Document</option>
			<option value="folder">Folder</option>
		</select>
	</div>

	<div class="evc-form-field">
		<label for="evc-visibility">Visibility</label>
		<select id="evc-visibility" class="dropdown" bind:value={visibility}>
			<option value="private">Private - Only members</option>
			<option value="public">Public - Anyone with link</option>
			<option value="protected">Protected - Password required</option>
		</select>
	</div>

	{#if visibility === "protected"}
		<div class="evc-form-field">
			<label for="evc-password">Password</label>
			<input
				id="evc-password"
				type="password"
				placeholder="Enter password for protected share"
				bind:value={password}
			/>
		</div>
	{/if}

	<div class="evc-form-actions">
		<button class="mod-cta" on:click={handleCreate} disabled={creating}>
			{creating ? "Creating..." : "Create Share"}
		</button>
		<button on:click={() => dispatch('cancel')}>Cancel</button>
	</div>
</div>

<style>
	.evc-create-share {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.evc-section-title {
		font-weight: 600;
		font-size: 1.05em;
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

	.evc-path-selector {
		display: flex;
	}

	.evc-path-btn {
		flex: 1;
		text-align: left;
		padding: 8px 12px;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 6px;
		cursor: pointer;
		color: var(--text-normal);
	}

	.evc-path-btn:hover {
		border-color: var(--interactive-accent);
	}

	.evc-form-actions {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}
</style>
