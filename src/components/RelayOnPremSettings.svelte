<script lang="ts">
	import type Live from "../main";
	import SignIn from "./SignIn.svelte";

	export let plugin: Live;

	// One screen, and no navigation on it. A vault is one share (ADR-0042), so
	// the list of shares was a list of one, and the screens under it (a share's
	// detail, invite somebody, agent keys) were a second level reached from a
	// row that repeated the row above it. What is left is who is signed in and
	// what the vault is doing.
</script>

<div class="synced-vaults-settings">
	<!-- The header is a title and a line of description. The link row that used
	     to sit under it (documentation, MCP server, mesh) and the icon buttons
	     beside it all led off this screen, which is not what somebody opened
	     settings to do. -->
	<div class="evc-settings-header">
		<div class="evc-header-top">
			<div class="evc-header-text">
				<div class="evc-header-title">Synced Vaults</div>
				<div class="evc-header-desc">Your vault on Knap, on every device you use</div>
			</div>
		</div>
	</div>

	<div class="evc-settings-content">
		<SignIn {plugin} />
	</div>
</div>

<style>
	.synced-vaults-settings {
		padding: 0;
	}

	/* Header */
	.evc-settings-header {
		padding: 16px 20px;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.evc-header-top {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.evc-header-text {
		flex: 1;
		min-width: 0;
	}

	.evc-header-title {
		font-size: 17px;
		font-weight: 700;
		color: var(--text-normal);
		letter-spacing: -0.2px;
		line-height: 1.2;
	}

	.evc-header-desc {
		font-size: 13px;
		color: var(--text-muted);
		margin-top: 1px;
	}

	/* Content */
	.evc-settings-content {
		padding: 16px 20px;
	}
</style>
