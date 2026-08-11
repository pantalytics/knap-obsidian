<script lang="ts">
	import { Notice } from "obsidian";
	import { createEventDispatcher, onMount } from "svelte";
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import type { RelayOnPremShare } from "../RelayOnPremShareClient";
	import { LimitExceededApiError } from "../RelayOnPremShareClient";
	import { findShareForPath } from "../shareDuplicates";
	import { FolderSuggestModal } from "../ui/FolderSuggestModal";

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

	// What the server already has, so the form can refuse a second share on a
	// folder that already has one. An empty list because the lookup failed is
	// not the same as an empty list because there are no shares, so the two are
	// tracked apart: with nothing to check against, the form does not block.
	let existingShares: RelayOnPremShare[] = [];
	let knowExistingShares = false;

	// Whatever the form has to say sits in the form. A Notice is gone in a few
	// seconds, and a create that failed while the person was looking at the
	// fields used to leave nothing behind at all.
	let error = "";

	$: duplicate = knowExistingShares
		? findShareForPath(existingShares, selectedPath)
		: undefined;

	onMount(() => {
		void refreshExistingShares();
	});

	async function refreshExistingShares() {
		try {
			if (plugin.shareClientManager) {
				existingShares = await plugin.shareClientManager.listShares(server.id);
			} else if (plugin.shareClient) {
				existingShares = await plugin.shareClient.listShares();
			} else {
				return;
			}
			knowExistingShares = true;
		} catch (e: unknown) {
			knowExistingShares = false;
			console.warn("[RelayOnPrem] Could not list existing shares:", e);
		}
	}

	function choosePath() {
		const modal = new FolderSuggestModal(
			plugin.app,
			"Choose a folder…",
			new Set(),
			plugin.sharedFolders,
			(folderPath: string) => {
				selectedPath = folderPath;
				error = "";
			},
		);
		modal.open();
	}

	// Create local SharedFolder for CRDT sync
	function registerLocalFolder(share: RelayOnPremShare) {
		if (share.kind !== "folder") {
			return;
		}
		try {
			plugin.sharedFolders.new(share.path, share.id, "relay-onprem", false);
			plugin.folderNavDecorations?.quickRefresh();
		} catch (e: unknown) {
			console.error("[RelayOnPrem] Failed to create SharedFolder:", e);
		}
	}

	// madeHere is false when the folder turned out to be shared but this form
	// cannot claim to be what shared it, so the notice does not say it did.
	function finish(share: RelayOnPremShare, madeHere = true) {
		registerLocalFolder(share);
		new Notice(
			madeHere
				? `${share.path} is syncing now.`
				: `${share.path} already syncs.`,
		);
		dispatch("created", { share });
	}

	async function handleCreate() {
		error = "";

		const path = selectedPath.trim();
		if (!path) {
			error = "Pick a folder first.";
			return;
		}
		if (visibility === "protected" && !password.trim()) {
			error = "A protected folder needs a password.";
			return;
		}
		if (duplicate) {
			error = `${duplicate.path} already syncs. Open it from the list instead of adding it twice.`;
			return;
		}

		// Whether the server's list was in hand before sending. Reaching here with
		// it means the folder was confirmed unshared a moment ago, which is what
		// lets a share found afterwards be read as this create having landed.
		const knewShares = knowExistingShares;

		creating = true;
		try {
			const createRequest = {
				path,
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

			finish(share);
		} catch (e: unknown) {
			await reportFailure(e, path, knewShares);
		} finally {
			creating = false;
		}
	}

	// A create that throws has not always failed. The server can write the record
	// and then the reply is what goes wrong, which is how a folder ended up
	// syncing while the form sat there saying nothing. So ask what is there
	// before telling anyone the folder was not added.
	async function reportFailure(e: unknown, path: string, knewShares: boolean) {
		if (e instanceof LimitExceededApiError) {
			const info = e.limitInfo;
			error = `You are syncing ${info.current} of ${info.max} folders on the ${info.plan} plan. Upgrade to add another.`;
			return;
		}

		await refreshExistingShares();
		const landed = knowExistingShares
			? findShareForPath(existingShares, path)
			: undefined;
		if (landed) {
			finish(landed, knewShares);
			return;
		}

		error = `${path} was not added. ${e instanceof Error ? e.message : "No reason came back."}`;
	}
</script>

<div class="evc-create-share">
	<div class="evc-section-title">Add a folder</div>

	{#if error}
		<div class="evc-form-error" role="alert">{error}</div>
	{/if}

	<div class="evc-form-field">
		<label for="evc-path-btn">Path</label>
		<div class="evc-path-selector">
			<button id="evc-path-btn" class="evc-path-btn" on:click={choosePath}>
				{selectedPath || "Choose a folder…"}
			</button>
		</div>
		{#if duplicate}
			<div class="evc-form-warning">
				This folder already syncs.
			</div>
		{/if}
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
			<option value="private">Private, only people you add</option>
			<option value="public">Public, anyone with the link</option>
			<option value="protected">Protected, password needed</option>
		</select>
	</div>

	{#if visibility === "protected"}
		<div class="evc-form-field">
			<label for="evc-password">Password</label>
			<input
				id="evc-password"
				type="password"
				placeholder="Password for this folder"
				bind:value={password}
			/>
		</div>
	{/if}

	<div class="evc-form-actions">
		<button class="mod-cta" on:click={handleCreate} disabled={creating || !!duplicate}>
			{creating ? "Adding…" : "Add folder"}
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

	.evc-form-error {
		padding: 10px 12px;
		border-radius: 6px;
		font-size: 0.9em;
		color: var(--text-error);
		background: var(--background-modifier-error);
	}

	.evc-form-warning {
		font-size: 0.85em;
		color: var(--text-warning, var(--color-yellow));
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
