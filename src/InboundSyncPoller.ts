/**
 * Inbound Sync Poller (v1.9)
 *
 * Polls web_content_updated_at on connected folder shares at a fixed cadence.
 * On detecting a bump, triggers InboundFileDownloader to pull new sync-artifact items.
 * Skips polls while an outbound sync is in flight to prevent echo loops.
 */

import { curryLog } from "./debug";
import type { InboundFileDownloader } from "./InboundFileDownloader";
import type { RelayOnPremShareClientManager } from "./RelayOnPremShareClientManager";
import type { TimeProvider } from "./TimeProvider";
import type { WebSyncManager } from "./WebSyncManager";

const log = curryLog("[InboundSyncPoller]");

const DEFAULT_POLL_INTERVAL_MS = 30_000;

interface WatchedShare {
	serverId: string;
	lastUpdatedAt: string | null;
}

export class InboundSyncPoller {
	private watchedShares: Map<string, WatchedShare> = new Map();
	private intervalId: number | null = null;

	constructor(
		private readonly timeProvider: TimeProvider,
		private readonly clientManager: RelayOnPremShareClientManager,
		private readonly webSyncManager: WebSyncManager,
		private readonly fileDownloader: InboundFileDownloader,
		private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	) {}

	registerShare(shareId: string, serverId: string): void {
		this.watchedShares.set(shareId, { serverId, lastUpdatedAt: null });
		log("Registered share for polling", { shareId, serverId });
	}

	unregisterShare(shareId: string): void {
		this.watchedShares.delete(shareId);
		log("Unregistered share from polling", { shareId });
	}

	start(): void {
		if (this.intervalId !== null) return;
		this.intervalId = this.timeProvider.setInterval(
			() => { void this._poll(); },
			this.pollIntervalMs,
		);
		log("Started polling", { intervalMs: this.pollIntervalMs });
	}

	private async _poll(): Promise<void> {
		if (this.webSyncManager.isOutboundSyncing) {
			log("Skipping poll — outbound sync in flight");
			return;
		}
		for (const [shareId, info] of this.watchedShares) {
			await this._checkShare(shareId, info.serverId, info.lastUpdatedAt);
		}
	}

	private async _checkShare(
		shareId: string,
		serverId: string,
		lastUpdatedAt: string | null,
	): Promise<void> {
		try {
			// Bypass the 5-min share cache so server-side bumps are detected within one poll cycle
			const share = await this.clientManager.getShare(serverId, shareId, true);
			const newUpdatedAt = share.web_content_updated_at ?? null;
			if (!newUpdatedAt) return;
			if (newUpdatedAt === lastUpdatedAt) {
				log("web_content_updated_at unchanged, skipping", { shareId });
				return;
			}
			log("web_content_updated_at bumped, triggering download", {
				shareId,
				newUpdatedAt,
			});
			// Only advance lastUpdatedAt if the download actually ran (not skipped due to
			// outbound sync in flight) so a skipped cycle retries on the next poll.
			const result = await this.fileDownloader.downloadShare(shareId, serverId);
			if (result !== "skipped") {
				this.watchedShares.set(shareId, { serverId, lastUpdatedAt: newUpdatedAt });
			}
		} catch (err: unknown) {
			log("Failed to check share", {
				shareId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	destroy(): void {
		if (this.intervalId !== null) {
			this.timeProvider.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.watchedShares.clear();
		log("InboundSyncPoller destroyed");
	}
}
