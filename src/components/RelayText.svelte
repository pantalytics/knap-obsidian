<script lang="ts">
	export let size: number = 64;
	let fontSize = size / 3;
</script>

<div class="evc-team-relay-text" style="font-size: {fontSize}px;">
	<span class="evc-text">EVC Team Relay</span>
</div>

<style>
	.evc-team-relay-text {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-normal);
	}

	.evc-text {
		font-weight: 600;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}
</style>
