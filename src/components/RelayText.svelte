<script lang="ts">
	export let size: number = 64;
	let fontSize = size / 3;
</script>

<div class="synced-vaults-text" style="font-size: {fontSize}px;">
	<span class="knap-text">Synced Vaults</span>
</div>

<style>
	.synced-vaults-text {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-normal);
	}

	.knap-text {
		font-weight: 600;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}
</style>
