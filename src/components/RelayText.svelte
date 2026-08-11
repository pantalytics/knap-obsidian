<script lang="ts">
	export let size: number = 64;
	let fontSize = size / 3;
</script>

<div class="knap-sync-text" style="font-size: {fontSize}px;">
	<span class="knap-text">Knap Sync</span>
</div>

<style>
	.knap-sync-text {
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
