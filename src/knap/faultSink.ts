/**
 * Where the sync layer files a fault, without knowing what a fault is.
 *
 * `src/faults.ts` talks to Obsidian (`Platform`, `requestUrl`) and to the
 * network. Everything in this directory except the `Obsidian*` adapters is
 * deliberately portable: it runs under jest against fake stores and a fake
 * socket, and importing the reporter into it would drag Obsidian in with it.
 *
 * So the reporter is injected, exactly like the file store and the fetch are.
 * `ObsidianKnap` sets the sink once at load; a test that does not set one
 * gets the no-op, which is also what a build with fault reporting turned off
 * behaves like.
 *
 * Every call here is swallowed. This is the module a piece of code reaches
 * for when it has *already* failed, and a reporter that throws on top of that
 * is a bug hidden behind a bug.
 */

/**
 * Which part of the sync layer a fault happened in. A subset of
 * `FAULT_COMPONENTS` in `src/faults.ts`, spelled again rather than imported
 * so that nothing here has a path to Obsidian.
 */
export type KnapFaultComponent =
	| "sync"
	| "auth"
	| "tokens"
	| "settings"
	| "startup"
	| "attachments"
	| "tree"
	| "link"
	| "mirror";

/** What a host has to provide for faults to go anywhere. */
export interface FaultSink {
	report(component: KnapFaultComponent, error: unknown): void;
	/** The device's token on sign-in, "" on sign-out. See ADR-0095. */
	credential(token: string): void;
}

const NOWHERE: FaultSink = {
	report: () => undefined,
	credential: () => undefined,
};

let sink: FaultSink = NOWHERE;

/** Point the sync layer's faults at a real reporter. Called once, at load. */
export function setFaultSink(next: FaultSink): void {
	sink = next;
}

/** Undo it, for a test that wants the silence back. */
export function clearFaultSink(): void {
	sink = NOWHERE;
}

/** File one fault. Never throws, whatever the sink does. */
export function knapFault(component: KnapFaultComponent, error: unknown): void {
	try {
		sink.report(component, error);
	} catch {
		// See the module note: this is the one failure that cannot be
		// allowed to have a failure of its own.
	}
}

/** Say whose device this is now, so a fault may say more (ADR-0095). */
export function knapCredential(token: string): void {
	try {
		sink.credential(token);
	} catch {
		// Same.
	}
}
