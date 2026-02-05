<script lang="ts">
	import type Live from "../main";
	import RelayOnPremServerList from "./RelayOnPremServerList.svelte";
	import evcLogo from "../assets/evc-logo.png";

	export let plugin: Live;

	const GITHUB_REPO = "entire-vc/relay-obsidian-plugin";
	const EVC_URL = "https://github.com/entire-vc/evc-team-relay";
	const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;

	let stars: number | null = null;

	// Fetch GitHub stars on mount (silently fails for private repos)
	async function fetchGitHubStars() {
		try {
			const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`);
			if (response.ok) {
				const data = await response.json();
				stars = data.stargazers_count;
			}
			// Silently ignore 404/403 for private repos
		} catch {
			// Silently fail - stars will just not show
		}
	}

	fetchGitHubStars();

	function formatStars(count: number): string {
		if (count >= 1000) {
			return (count / 1000).toFixed(1) + "k";
		}
		return count.toString();
	}
</script>

<div class="relay-onprem-settings">
	<!-- Header Section -->
	<div class="settings-header">
		<a href={EVC_URL} class="header-brand" target="_blank" rel="noopener noreferrer">
			<img
				src={evcLogo}
				alt="EVC Logo"
				class="header-logo"
			/>
			<div class="header-text">
				<div class="header-title">Entire VC Team Relay</div>
				<div class="header-description">
					Use self-hosted relay-onprem control plane for work with your teammates
				</div>
			</div>
		</a>
		<a
			href={GITHUB_URL}
			class="github-badge"
			target="_blank"
			rel="noopener noreferrer"
			title="View on GitHub"
		>
			<svg class="github-icon" viewBox="0 0 16 16" fill="currentColor">
				<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
			</svg>
			{#if stars !== null}
				<span class="stars-count">{formatStars(stars)}</span>
			{/if}
		</a>
	</div>

	<!-- Server List Section -->
	<div class="relay-onprem-config">
		<div class="setting-item-heading">
			<div class="setting-item-name">Relay Servers</div>
			<div class="setting-item-description">
				Configure your relay-onprem servers. You can add multiple servers and switch between them.
				Use the "Shares" button to manage shares for each server.
			</div>
		</div>

		<RelayOnPremServerList {plugin} />
	</div>
</div>

<style>
	.relay-onprem-settings {
		padding: 10px 0;
	}

	.settings-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px;
		margin-bottom: 16px;
		background: var(--background-secondary);
		border-radius: 8px;
	}

	.header-brand {
		display: flex;
		align-items: center;
		gap: 12px;
		text-decoration: none;
		color: inherit;
		transition: opacity 0.2s;
	}

	.header-brand:hover {
		opacity: 0.8;
	}

	.header-logo {
		width: 40px;
		height: 40px;
		border-radius: 8px;
	}

	.header-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.header-title {
		font-weight: 600;
		font-size: 1.4rem;
		color: #4F566B;
	}

	.header-description {
		color: var(--text-muted);
		font-size: 0.85em;
	}

	.github-badge {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		background: var(--background-modifier-border);
		border-radius: 6px;
		text-decoration: none;
		color: var(--text-muted);
		transition: all 0.2s;
	}

	.github-badge:hover {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}

	.github-icon {
		width: 16px;
		height: 16px;
	}

	.stars-count {
		font-size: 0.85em;
		font-weight: 500;
	}

	.relay-onprem-config {
		padding-left: 0;
	}

	.setting-item-heading {
		margin-top: 0;
		margin-bottom: 12px;
	}

	.setting-item-heading .setting-item-name {
		font-weight: 600;
		font-size: 1.1em;
	}

	.setting-item-heading .setting-item-description {
		color: var(--text-muted);
		font-size: 0.9em;
		margin-top: 4px;
	}
</style>
