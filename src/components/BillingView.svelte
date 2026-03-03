<script lang="ts">
	import { onMount } from "svelte";
	import { Notice } from "obsidian";
	import type Live from "../main";
	import type { RelayOnPremServer } from "../RelayOnPremConfig";
	import { BillingApiError } from "../RelayOnPremShareClient";
	import type { BillingPlanResponse, AvailablePlan } from "../RelayOnPremShareClient";

	export let plugin: Live;
	export let server: RelayOnPremServer;

	let billingData: BillingPlanResponse | null = null;
	let availablePlans: AvailablePlan[] = [];
	let loading = true;
	let error: string | null = null;
	let cancellingSubscription = false;
	let checkingOut = false;
	let openingPortal = false;

	onMount(async () => {
		await loadBillingData();
	});

	function getClient() {
		return plugin.shareClientManager?.getClient(server.id) || plugin.shareClient;
	}

	async function loadBillingData() {
		loading = true;
		error = null;
		try {
			const client = getClient();
			if (!client) {
				error = "Not connected to server";
				return;
			}
			billingData = await client.getBillingPlan();
			try {
				availablePlans = await client.getAvailablePlans();
			} catch {
				// Non-critical
			}
		} catch (e: unknown) {
			error = e instanceof Error ? e.message : "Failed to load billing data";
		} finally {
			loading = false;
		}
	}

	function getUsagePercent(usage: { current: number; max: number | null; percentage: number | null }): number {
		if (usage.percentage !== null && usage.percentage !== undefined) return usage.percentage;
		if (usage.max === null || usage.max === 0) return 0;
		return Math.min(100, Math.round((usage.current / usage.max) * 100));
	}

	function getUsageClass(percent: number): string {
		if (percent >= 100) return "evc-usage-full";
		if (percent >= 80) return "evc-usage-warning";
		return "evc-usage-ok";
	}

	function formatLimit(max: number | null): string {
		return max === null ? "Unlimited" : String(max);
	}

	function formatBytes(bytes: number | null): string {
		if (bytes === null) return "Unlimited";
		if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
		if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
		return `${bytes} B`;
	}

	function formatPrice(amount: number, currency: string, period: string): string {
		const dollars = (amount / 100).toFixed(0);
		const sym = currency === "USD" ? "$" : currency;
		return `${sym}${dollars}/${period === "month" ? "mo" : "yr"}`;
	}

	function getEntitlementLimit(value: { limit: number | null } | number | null): number | null {
		if (value === null || value === undefined) return null;
		if (typeof value === "object" && "limit" in value) return value.limit;
		if (typeof value === "number") return value;
		return null;
	}

	function isCurrentPlan(plan: AvailablePlan): boolean {
		if (!billingData) return false;
		const bp = billingData.plan?.toLowerCase() || "";
		const pn = plan.name?.toLowerCase() || "";
		// Exact name match
		if (bp === pn) return true;
		// Free plan: match if user's plan contains "free"
		const isFreeCard = plan.prices?.every(p => p.amount === 0) ?? true;
		if (isFreeCard) return bp.includes("free") && !hasSub;
		// Paid plan: match if user has active subscription and is NOT on free plan
		return hasSub && !bp.includes("free");
	}

	function getPlanPrice(plan: AvailablePlan): string {
		const monthly = plan.prices?.find(p => p.billing_period === "month");
		if (!monthly || monthly.amount === 0) return "Free";
		const dollars = (monthly.amount / 100).toFixed(0);
		const sym = monthly.currency === "USD" ? "$" : monthly.currency;
		return `${sym}${dollars}/mo`;
	}

	const USAGE_LABELS: Record<string, string> = {
		shares: "Shares",
		web_published: "Web published",
		storage: "Storage",
	};

	const ENTITLEMENT_LABELS: Record<string, string> = {
		max_shares: "Shares",
		max_members_per_share: "Members per share",
		max_web_published: "Web published",
		max_storage_bytes: "Storage",
	};

	// Non-numeric entitlements to skip in the plan feature list
	const HIDDEN_ENTITLEMENTS = new Set(["allowed_web_visibility"]);

	async function handleUpgrade(plan: AvailablePlan, priceId: string) {
		checkingOut = true;
		try {
			const client = getClient();
			if (!client) throw new Error("Not connected");

			// Smart routing: existing active subscription → change plan, otherwise → new checkout
			if (hasSub && !isCancelled && billingData?.subscription?.id) {
				const result = await client.changePlan(plan.id, priceId);
				new Notice(result.message || "Plan changed successfully!");
				await loadBillingData();
			} else {
				const result = await client.createCheckout(plan.id, priceId);
				if (result.checkout_url) {
					window.open(result.checkout_url);
					new Notice("Opening checkout in browser...");
				} else {
					new Notice("Subscription activated!");
					await loadBillingData();
				}
			}
		} catch (e: unknown) {
			new Notice(`Upgrade failed: ${e instanceof Error ? e.message : "Unknown error"}`);
		} finally {
			checkingOut = false;
		}
	}

	async function handleManageSubscription() {
		openingPortal = true;
		try {
			const client = getClient();
			if (!client) throw new Error("Not connected");
			const result = await client.createPortalSession();
			if (result.url) {
				window.open(result.url);
				new Notice("Opening subscription portal in browser...");
			} else {
				new Notice(result.message || "Portal not available");
			}
		} catch (e: unknown) {
			new Notice(`Failed to open portal: ${e instanceof Error ? e.message : "Unknown error"}`);
		} finally {
			openingPortal = false;
		}
	}

	async function handleCancel() {
		cancellingSubscription = true;
		try {
			const client = getClient();
			if (!client) throw new Error("Not connected");
			await client.cancelSubscription();
			new Notice("Subscription cancelled. Access continues until end of billing period.");
			await loadBillingData();
		} catch (e: unknown) {
			new Notice(`Cancel failed: ${e instanceof Error ? e.message : "Unknown error"}`);
		} finally {
			cancellingSubscription = false;
		}
	}

	$: isFree = billingData?.plan === "free" || billingData?.plan === "Free" || billingData?.plan === "Relay Free";
	$: hasSub = billingData?.subscription !== null && billingData?.subscription !== undefined;
	$: isCancelled = billingData?.subscription?.cancel_at_period_end === true || billingData?.subscription?.status === "cancelled";
</script>

<div class="evc-billing-view">
	<div class="evc-section-title">Billing & Plan</div>
	<div class="evc-section-desc">on {server.name}</div>

	{#if loading}
		<div class="evc-loading">Loading billing info...</div>
	{:else if error}
		<div class="evc-error">{error}</div>
	{:else if billingData}
		<!-- Plan Cards -->
		{#if availablePlans.length > 0}
			<div class="evc-plans-grid">
				{#each availablePlans as plan (plan.id)}
					{@const current = isCurrentPlan(plan)}
					{@const isFreeCard = plan.prices?.every(p => p.amount === 0) ?? true}
					<div class="evc-plan-card" class:is-current={current} class:is-pro={!isFreeCard}>
						<!-- Header -->
						<div class="evc-plan-header">
							<div class="evc-plan-name">{plan.name}</div>
							{#if current}
								{#if isCancelled}
									<span class="evc-plan-badge evc-badge-warning">Cancelling</span>
								{:else if hasSub}
									<span class="evc-plan-badge evc-badge-active">Active</span>
								{:else}
									<span class="evc-plan-badge evc-badge-current">Current</span>
								{/if}
							{/if}
						</div>

						<!-- Price -->
						<div class="evc-plan-price">{getPlanPrice(plan)}</div>

						<!-- Entitlements -->
						<div class="evc-plan-features">
							{#each Object.entries(plan.entitlements || {}) as [key, value]}
								{#if !HIDDEN_ENTITLEMENTS.has(key)}
									{@const limit = getEntitlementLimit(value)}
									<div class="evc-plan-feature">
										<span class="evc-feature-value">
											{key === "max_storage_bytes" ? formatBytes(limit) : formatLimit(limit)}
										</span>
										<span class="evc-feature-label">{ENTITLEMENT_LABELS[key] || key}</span>
									</div>
								{/if}
							{/each}
						</div>

						<!-- Action -->
						<div class="evc-plan-action">
							{#if current}
								{#if isCancelled}
									{#each plan.prices as price}
										{#if price.amount > 0}
											<button
												class="evc-plan-btn evc-btn-upgrade"
												disabled={checkingOut}
												on:click={() => handleUpgrade(plan, price.id)}
											>
												{checkingOut ? "..." : "Resubscribe"}
											</button>
										{/if}
									{/each}
								{:else if hasSub}
									<button
										class="evc-plan-btn evc-btn-manage"
										disabled={openingPortal}
										on:click={handleManageSubscription}
									>
										{openingPortal ? "..." : "Manage"}
									</button>
									<button
										class="evc-plan-btn evc-btn-cancel"
										disabled={cancellingSubscription}
										on:click={handleCancel}
									>
										{cancellingSubscription ? "..." : "Cancel"}
									</button>
								{:else}
									<div class="evc-plan-btn evc-btn-current">Current plan</div>
								{/if}
							{:else if !isFreeCard}
								<div class="evc-plan-prices-row">
									{#each plan.prices as price}
										{#if price.amount > 0}
											<button
												class="evc-plan-btn evc-btn-upgrade"
												disabled={checkingOut}
												on:click={() => handleUpgrade(plan, price.id)}
											>
												{checkingOut ? "..." : formatPrice(price.amount, price.currency, price.billing_period)}
											</button>
										{/if}
									{/each}
								</div>
							{/if}
						</div>

						{#if current && isCancelled && billingData.subscription?.current_period_end}
							<div class="evc-plan-note">
								Access until {new Date(billingData.subscription.current_period_end).toLocaleDateString()}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<!-- Usage -->
		<div class="evc-usage-section">
			<div class="evc-usage-title">Your Usage</div>
			{#each Object.entries(billingData.usage) as [key, usage]}
				{@const percent = getUsagePercent(usage)}
				{@const usageClass = getUsageClass(percent)}
				<div class="evc-usage-item">
					<div class="evc-usage-label">
						<span>{USAGE_LABELS[key] || key}</span>
						<span class="evc-usage-count">
							{#if key === "storage"}
								{usage.current_bytes !== null && usage.current_bytes !== undefined
									? formatBytes(usage.current_bytes)
									: "—"} / {formatBytes(usage.max_bytes ?? usage.max)}
							{:else}
								{usage.current} / {formatLimit(usage.max)}
							{/if}
						</span>
					</div>
					<div class="evc-usage-bar">
						<div
							class="evc-usage-fill {usageClass}"
							style="width: {usage.max === null && usage.max_bytes === undefined ? 0 : percent}%"
						></div>
					</div>
					{#if percent >= 80 && (usage.max !== null || usage.max_bytes !== undefined)}
						<div class="evc-usage-hint {usageClass}">
							{#if percent >= 100}
								Limit reached
							{:else}
								{percent}% used
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Refresh -->
		<button class="evc-refresh-btn" on:click={loadBillingData}>
			Refresh
		</button>
	{/if}
</div>

<style>
	.evc-billing-view {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.evc-section-title {
		font-weight: 600;
		font-size: 1.05em;
	}

	.evc-section-desc {
		font-size: 0.85em;
		color: var(--text-muted);
		margin-top: -8px;
	}

	.evc-loading {
		padding: 24px;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--background-modifier-border);
		border-radius: 8px;
	}

	.evc-error {
		padding: 16px;
		color: var(--text-error);
		background: var(--background-modifier-error);
		border-radius: 8px;
	}

	/* Plan cards grid */
	.evc-plans-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 12px;
	}

	.evc-plan-card {
		display: flex;
		flex-direction: column;
		padding: 16px;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 8px;
		gap: 12px;
	}

	.evc-plan-card.is-current {
		border-color: var(--interactive-accent);
		border-width: 2px;
	}

	.evc-plan-card.is-pro:not(.is-current) {
		border-color: var(--text-faint);
	}

	.evc-plan-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.evc-plan-name {
		font-weight: 700;
		font-size: 1.05em;
	}

	.evc-plan-badge {
		font-size: 0.7em;
		padding: 2px 8px;
		border-radius: 12px;
		font-weight: 600;
		white-space: nowrap;
	}

	.evc-badge-current {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
	}

	.evc-badge-active {
		background: var(--background-modifier-success, #dcfce7);
		color: var(--text-success, #166534);
	}

	.evc-badge-warning {
		background: var(--background-modifier-error);
		color: var(--text-warning, #b08800);
	}

	.evc-plan-price {
		font-size: 1.4em;
		font-weight: 700;
		color: var(--text-normal);
	}

	.evc-plan-features {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex: 1;
	}

	.evc-plan-feature {
		display: flex;
		gap: 6px;
		align-items: baseline;
		font-size: 0.85em;
	}

	.evc-feature-value {
		font-weight: 600;
		min-width: 50px;
	}

	.evc-feature-label {
		color: var(--text-muted);
	}

	.evc-plan-action {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: auto;
	}

	.evc-plan-prices-row {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		width: 100%;
	}

	.evc-plan-btn {
		padding: 6px 14px;
		border-radius: 6px;
		font-size: 0.85em;
		font-weight: 600;
		cursor: pointer;
		text-align: center;
		border: none;
	}

	.evc-btn-current {
		background: var(--background-modifier-border);
		color: var(--text-muted);
		cursor: default;
		width: 100%;
	}

	.evc-btn-upgrade {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		flex: 1;
	}

	.evc-btn-upgrade:hover { opacity: 0.9; }
	.evc-btn-upgrade:disabled { opacity: 0.5; cursor: not-allowed; }

	.evc-btn-manage {
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		flex: 1;
	}

	.evc-btn-manage:hover { opacity: 0.9; }
	.evc-btn-manage:disabled { opacity: 0.5; cursor: not-allowed; }

	.evc-btn-cancel {
		background: transparent;
		color: var(--text-error);
		border: 1px solid var(--text-error);
	}

	.evc-btn-cancel:hover { background: var(--background-modifier-error); }
	.evc-btn-cancel:disabled { opacity: 0.5; cursor: not-allowed; }

	.evc-plan-note {
		font-size: 0.8em;
		color: var(--text-muted);
	}

	/* Usage section */
	.evc-usage-section {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.evc-usage-title {
		font-weight: 600;
		font-size: 0.95em;
	}

	.evc-usage-item {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.evc-usage-label {
		display: flex;
		justify-content: space-between;
		font-size: 0.9em;
	}

	.evc-usage-count {
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.evc-usage-bar {
		height: 6px;
		background: var(--background-modifier-border);
		border-radius: 3px;
		overflow: hidden;
	}

	.evc-usage-fill {
		height: 100%;
		border-radius: 3px;
		transition: width 0.3s ease;
	}

	.evc-usage-fill.evc-usage-ok { background: var(--interactive-accent); }
	.evc-usage-fill.evc-usage-warning { background: var(--text-warning, #b08800); }
	.evc-usage-fill.evc-usage-full { background: var(--text-error); }

	.evc-usage-hint { font-size: 0.8em; }
	.evc-usage-hint.evc-usage-warning { color: var(--text-warning, #b08800); }
	.evc-usage-hint.evc-usage-full { color: var(--text-error); }

	.evc-refresh-btn {
		padding: 4px 12px;
		background: transparent;
		color: var(--text-muted);
		border: 1px solid var(--background-modifier-border);
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8em;
		align-self: flex-start;
	}

	.evc-refresh-btn:hover { color: var(--text-normal); }
</style>
