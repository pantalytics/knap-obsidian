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
 * **Signed in, a fault says more (ADR-0095).** A device holding a Knap token
 * is a member of a vault whose notes are already sitting on that server, so
 * the error's own message and one line of where it happened go with it, and
 * the server writes them into the log for that vault. Without a token
 * nothing changes: four facts, no message, because an anonymous device is an
 * unknown person's vault. The credential is the switch and it is checked at
 * the moment of sending, so a fault queued while signed in and sent after
 * signing out loses its message on the way out.
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
	// The rebuilt sync layer (src/knap). It had no call sites at all until
	// ADR-0095, which is to say the code that actually runs reported nothing.
	"tree",
	"link",
	"mirror",
] as const;

export type FaultComponent = (typeof FAULT_COMPONENTS)[number];

export type FaultPlatform =
	| "desktop-mac"
	| "desktop-windows"
	| "desktop-linux"
	| "mobile-ios"
	| "mobile-android"
	| "unknown";

/**
 * The whole of what one fault says. Four keys always, and two more only when
 * a credential went with it.
 */
export interface Fault {
	type: string;
	component: FaultComponent;
	version: string;
	platform: FaultPlatform;
	/** The error's own message. Only ever set on a signed-in report. */
	message?: string;
	/** One frame of where it happened. Same condition. */
	where?: string;
}

/** How long each of the two extra fields may be. The server has its own. */
const MAX_MESSAGE = 400;
const MAX_WHERE = 200;

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
 * One line of the error's own message, or "". Newlines go: a fault becomes a
 * log line on the server, and a message that can carry a newline can carry a
 * whole fake log line after it.
 */
function faultMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : "";
	return raw.split(/\s+/).join(" ").trim().slice(0, MAX_MESSAGE);
}

/**
 * The top frame of the stack, as one short string.
 *
 * Where in *the plugin*, never where in the vault: a stack frame names a
 * bundled module and a line number, which is exactly what is worth having and
 * carries nothing about anybody's notes. Missing on a thrown non-Error and on
 * platforms that do not fill `stack` in, and missing is fine.
 */
function faultWhere(error: unknown): string {
	const stack = error instanceof Error ? error.stack : "";
	if (!stack) return "";
	const frame = stack.split("\n").find((line) => /^\s*at\s/.test(line));
	return frame ? frame.trim().slice(0, MAX_WHERE) : "";
}

/**
 * Reduce an error to the facts that may leave the device. This is the one
 * gate: `report` calls it and nothing else builds a fault, so a message
 * cannot reach the wire through any call site.
 *
 * `credentialed` is the whole of the difference ADR-0095 made. False is
 * ADR-0071 unchanged.
 */
export function scrubFault(
	component: FaultComponent,
	error: unknown,
	credentialed = false,
): Fault {
	const fault: Fault = {
		type: faultType(error),
		component,
		version: GIT_TAG,
		platform: faultPlatform(),
	};
	if (!credentialed) return fault;
	const message = faultMessage(error);
	const where = faultWhere(error);
	if (message) fault.message = message;
	if (where) fault.where = where;
	return fault;
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
	/**
	 * This device's Knap token, while it has one. Held so a report can prove
	 * who is making it; never read for anything else, and never logged.
	 */
	private credential = "";

	constructor(private readonly endpoint: string = faultsEndpoint()) {}

	/**
	 * Whose reports these are. Called on sign-in with the token and on sign
	 * out with "".
	 *
	 * Signing out does not drop the queue the way turning reporting off does:
	 * the faults are still worth having, they just stop saying more than an
	 * anonymous one may.
	 */
	setCredential(token: string): void {
		this.credential = token;
	}

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
			const fault = scrubFault(component, error, this.credential !== "");
			// The message is part of the key. Two failures with the same type
			// and different messages are two failures, and folding them would
			// throw away the half that says which.
			const key = [
				fault.type,
				fault.component,
				fault.version,
				fault.platform,
				fault.message ?? "",
			].join("|");
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
		const token = this.credential;
		// Checked here rather than at report time: a fault queued while
		// signed in and sent after signing out has nothing to prove itself
		// with, so it goes out as an anonymous one instead of carrying a
		// message the server would drop anyway.
		const faults = [...this.queue.values()].map((fault) =>
			token ? fault : { ...fault, message: undefined, where: undefined },
		);
		this.queue.clear();
		try {
			await requestUrl({
				url: this.endpoint,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
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

/**
 * Tell the reporter which device it is reporting for: the Knap token on sign
 * in, "" on sign out. With one, a fault may carry its message (ADR-0095).
 */
export function setFaultCredential(token: string): void {
	reporter.setCredential(token);
}
