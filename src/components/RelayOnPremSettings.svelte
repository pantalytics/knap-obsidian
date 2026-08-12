<script lang="ts">
	import type Live from "../main";
	import SignIn from "./SignIn.svelte";

	export let plugin: Live;

	// One screen, and no navigation on it. A vault is one share (ADR-0043), so
	// the list of shares was a list of one, and the screens under it (a share's
	// detail, invite somebody, agent keys) were a second level reached from a
	// row that repeated the row above it. What is left is who is signed in and
	// what the vault is doing.
	//
	// The header is the plugin's name and a rule under it, and nothing else
	// (ADR-0045). The line of description that used to sit here said what the
	// plugin does, which is a question somebody answered before installing it.
</script>

<div class="knap-settings">
	<div class="knap-settings-header">Knap</div>

	<div class="knap-settings-content">
		<SignIn {plugin} />
	</div>
</div>

<style>
	.knap-settings {
		padding: 0;
	}

	.knap-settings-header {
		padding: 16px 20px;
		border-bottom: 1px solid var(--background-modifier-border);
		font-size: 17px;
		font-weight: 700;
		color: var(--text-normal);
		letter-spacing: -0.2px;
		line-height: 1.2;
	}

	.knap-settings-content {
		padding: 8px 20px 16px;
	}
</style>
