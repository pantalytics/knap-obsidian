import { requestUrl } from "obsidian";
import { curryLog } from "./debug";

const log = curryLog("[Telemetry]");

const POSTHOG_HOST = "https://eu.i.posthog.com";
const POSTHOG_API_KEY = "phc_j4UVY0yala179fAFaPeS9nYE2B60wF6X11CFOW6ceuW";

/**
 * Check if a server URL belongs to Entire VC infrastructure.
 * Telemetry is only allowed for *.entire.vc servers.
 */
export function isEntireVCServer(serverUrl: string): boolean {
	try {
		const host = new URL(serverUrl).hostname;
		return host === "entire.vc" || host.endsWith(".entire.vc");
	} catch {
		return false;
	}
}

export class Telemetry {
	private enabled: boolean;
	private distinctId: string;
	private pluginVersion: string;

	constructor(enabled: boolean, anonymousId: string, pluginVersion: string) {
		this.enabled = enabled;
		this.distinctId = anonymousId;
		this.pluginVersion = pluginVersion;
	}

	setEnabled(enabled: boolean) {
		this.enabled = enabled;
		log("Telemetry", enabled ? "enabled" : "disabled");
	}

	async capture(event: string, properties: Record<string, unknown> = {}) {
		if (!this.enabled) return;

		try {
			await requestUrl({
				url: `${POSTHOG_HOST}/capture/`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					api_key: POSTHOG_API_KEY,
					event,
					distinct_id: this.distinctId,
					properties: {
						...properties,
						app: "relay-obsidian-plugin",
						plugin_version: this.pluginVersion,
						$lib: "posthog-node",
					},
					timestamp: new Date().toISOString(),
				}),
			});
		} catch {
			// Silent fail — telemetry must never break the plugin
		}
	}
}
