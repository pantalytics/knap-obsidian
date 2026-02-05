<script lang="ts">
	import TFolderSuggest from "./TFolderSuggest.svelte";
	import { FolderSuggestModal } from "../ui/FolderSuggestModal";
	import { FolderOpen } from "lucide-svelte";
	import type { App } from "obsidian";
	import type { Writable } from "svelte/store";
	import type { SharedFolders } from "src/SharedFolder";

	export let app: App;
	export let sharedFolders: SharedFolders;
	export let selectedFolder: Writable<string | undefined>;
	export let placeholder = "Choose or create folder...";
	export let disabled: boolean = false;
	export let showBrowseButton: boolean = true;

	let currentValue = "";

	function getBlockedPaths() {
		return new Set<string>(
			sharedFolders
				.filter((folder) => !!folder.relayId)
				.map((folder) => folder.path),
		);
	}

	// Initialize from external store if it has a value
	$: if ($selectedFolder && $selectedFolder !== currentValue) {
		currentValue = $selectedFolder;
	}

	function handleSelect(e: CustomEvent) {
		const folderPath = e.detail.value;
		currentValue = folderPath;
		selectedFolder.set(folderPath);
	}

	function handleModalSelect(folderPath: string) {
		currentValue = folderPath;
		selectedFolder.set(folderPath);
	}

	function openBrowseModal() {
		const modal = new FolderSuggestModal(
			app,
			placeholder,
			getBlockedPaths(),
			sharedFolders,
			handleModalSelect,
		);
		modal.open();
	}
</script>

<div class="folder-select-input" class:with-browse={showBrowseButton}>
	<TFolderSuggest
		{app}
		{placeholder}
		{disabled}
		blockedPaths={getBlockedPaths()}
		bind:value={currentValue}
		on:select={handleSelect}
	/>
	{#if showBrowseButton}
		<button
			type="button"
			class="browse-button"
			{disabled}
			on:click={openBrowseModal}
			title="Browse folders"
		>
			<FolderOpen class="svg-icon" size={16} />
		</button>
	{/if}
</div>

<style>
	.folder-select-input {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.folder-select-input.with-browse :global(.folder-suggest-wrapper) {
		flex: 1;
	}

	.browse-button {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 8px;
		border: 1px solid var(--background-modifier-border);
		border-radius: 4px;
		background: var(--background-primary);
		color: var(--text-muted);
		cursor: pointer;
		flex-shrink: 0;
	}

	.browse-button:hover:not(:disabled) {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	.browse-button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
