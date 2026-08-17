/**
 * Fault reporting: the plugin says that it failed, and never what it held
 * (ADR-0071).
 *
 * When something breaks on a device, the maker used to hear about it through a
 * personal message or not at all. This module is the fix, and it is one module
 * on purpose: every beacon call site is a place where a note path could leak
 * by accident, so the scrubbing lives here and the call sites cannot bypass
 * it. A call site hands over an error and the name of the component it was in,
 * and what leaves the device is exactly four facts: the error's type, the
 * component, the plugin version and the platform. Never the message, because
 * messages carry paths ("ENOENT: Clients/Acme/renewal.md"), and a path is a
 * fact about somebody's business.
 *
 * The reporter itself must never cause a fault. It batches, it sends at most
 * one request every few minutes, and a send that fails is dropped without a
 * retry: a fault reporter that hammers a struggling server is a second bug on
 * top of the first.
 *
 * On by default, with the off switch in settings (main.ts wires the setting to
 * `setFaultReporting`). Off means no queueing and no network at all.
 */

import { Platform, requestUrl } from "obsidian";
import { KNAP_PANEL_URL } from "./RelayOnPremConfig";

declare const GIT_TAG: string;

/**
 * The components a fault can be filed under. A fixed allowlist rather than a
 * free string, so a call site cannot smuggle anything else into the field:
 * the server coerces anything off this list to "unknown".
 */
export const FAULT_COMPONENTS = [
	"sync",
	"auth",
	"tokens",
	"settings",
	"startup",
	"attachments",
] as const;

export type FaultComponent = (typeof FAULT_COMPONENTS)[number];

export type FaultPlatform =
	| "desktop-mac"
	| "desktop-windows"
	| "desktop-linux"
	| "mobile-ios"
	| "mobile-android"
	| "unknown";

/** The whole of what one fault says. Four keys, and nothing else ever. */
export interface Fault {
	type: string;
	component: FaultComponent;
	version: string;
	platform: FaultPlatform;
}

/** One entry on the wire: a fault, folded with how often it happened. */
export interface QueuedFault extends Fault {
	count: number;
}

/** How long a batch waits before it is sent, and the floor between sends. */
export const SEND_EVERY_MS = 3 * 60_000;

/** Distinct faults a batch will hold. Beyond this, new shapes are dropped. */
export const MAX_BATCH = 20;

/**
 * Where the beacons go: the Knap panel's origin. The path is fixed and the
 * origin is build configuration, like everything else about the one server.
 */
export function faultsEndpoint(): string {
	return new URL("/faults", KNAP_PANEL_URL).toString();
}

/**
 * Which platform this install runs on. Mobile is asked first: the desktop
 * flags describe the operating system and iPadOS answers for macOS too.
 */
export function faultPlatform(): FaultPlatform {
	if (Platform.isIosApp) return "mobile-ios";
	if (Platform.isAndroidApp) return "mobile-android";
	if (Platform.isWin) return "desktop-windows";
	if (Platform.isLinux) return "desktop-linux";
	if (Platform.isMacOS) return "desktop-mac";
	return "unknown";
}

/**
 * The error's type, and only its type. The constructor name is a class
 * identifier, which cannot hold a path; the message can and often does, so it
 * is never read. Anything that is not an Error gets a stable stand-in rather
 * than a stringification, for the same reason.
 */
function faultType(error: unknown): string {
	if (error instanceof Error) {
		return error.constructor?.name || error.name || "Error";
	}
	return "NonError";
}

/**
 * Reduce an error to the four facts that may leave the device. This is the
 * one gate: `report` calls it and nothing else builds a fault, so a message
 * cannot reach the wire through any call site.
 */
export function scrubFault(component: FaultComponent, error: unknown): Fault {
	return {
		type: faultType(error),
		component,
		version: GIT_TAG,
		platform: faultPlatform(),
	};
}

/**
 * The queue and the clock. One instance serves the plugin (the module-level
 * singleton below); the class is exported so the tests can drive one against
 * a fake endpoint and fake timers.
 */
export class FaultReporter {
	private enabled = true;
	private queue = new Map<string, QueuedFault>();
	private timer: number | null = null;

	constructor(private readonly endpoint: string = faultsEndpoint()) {}

	/**
	 * The off switch. Off drops the queue and the pending send as well:
	 * a fault that happened while reporting was on does not get sent after
	 * somebody turned it off.
	 */
	setEnabled(on: boolean): void {
		this.enabled = on;
		if (!on) {
			this.queue.clear();
			if (this.timer !== null) {
				window.clearTimeout(this.timer);
				this.timer = null;
			}
		}
	}

	/**
	 * File one fault. Identical faults fold into one entry with a count, and
	 * the first fault in an empty queue starts the clock: one send per
	 * SEND_EVERY_MS, however many faults arrive in between.
	 *
	 * Never throws. A fault reporter that faults is the one failure this
	 * module is not allowed to have.
	 */
	report(component: FaultComponent, error: unknown): void {
		if (!this.enabled) return;
		try {
			const fault = scrubFault(component, error);
			const key = `${fault.type}|${fault.component}|${fault.version}|${fault.platform}`;
			const existing = this.queue.get(key);
			if (existing) {
				existing.count += 1;
			} else if (this.queue.size < MAX_BATCH) {
				this.queue.set(key, { ...fault, count: 1 });
			}
			if (this.timer === null) {
				this.timer = window.setTimeout(() => {
					this.timer = null;
					void this.flush();
				}, SEND_EVERY_MS);
			}
		} catch {
			// Dropped on purpose. See above.
		}
	}

	/**
	 * Send what is queued, once. The queue is cleared before the request goes
	 * out, so a failure drops the batch instead of retrying it: the next
	 * fault starts a fresh one.
	 */
	private async flush(): Promise<void> {
		if (!this.enabled || this.queue.size === 0) return;
		const faults = [...this.queue.values()];
		this.queue.clear();
		try {
			await requestUrl({
				url: this.endpoint,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ faults }),
				throw: false,
			});
		} catch {
			// Dropped on purpose: no retry, no error about the error.
		}
	}
}

const reporter = new FaultReporter();

/** File one fault with the plugin's own reporter. The one-line call site. */
export function reportFault(component: FaultComponent, error: unknown): void {
	reporter.report(component, error);
}

/** Wire the settings toggle through. Off means no queueing and no network. */
export function setFaultReporting(enabled: boolean): void {
	reporter.setEnabled(enabled);
}
