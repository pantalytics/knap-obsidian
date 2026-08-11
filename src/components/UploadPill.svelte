<script lang="ts">
	import type { Readable } from "svelte/store";

	// A store, for the same reason as Pill: FolderNav updates the tag from
	// plain TypeScript and $set is gone in Svelte 5.
	export let text: Readable<string>;
	export let label: string = "";
	export let color: string | undefined = undefined;
</script>

<div
	class="nav-file-tag system3-uploadpill"
	aria-label={label}
	style={color ? `color:${color}` : ""}
>
	<span>{$text}</span>
</div>

<style>
	.system3-uploadpill {
		text-wrap: nowrap;
	}
</style>
