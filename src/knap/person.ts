/**
 * What to call the person at this device, on a screen somebody else reads.
 *
 * Two places need it and both used to name a machine. A caret in a shared
 * note carried the device name, which reads fine on your own laptop and
 * names nobody in a vault with two people in it. A conflict copy carried
 * the date alone, so two people conflicting on one note on one day produced
 * the same filename and neither could tell which copy was theirs.
 *
 * The address is what the server can answer for (ADR-0081), and the local
 * part of it is what a colleague recognises: `daniel`, not
 * `daniel@pantalytics.com`, which is three times as wide on a caret and
 * carries a domain that is the same for everybody in the vault anyway.
 *
 * The device name is the fallback rather than the answer, because an
 * account whose issuer returned no address is a real case and a nameless
 * caret is worse than a machine-named one. Pure on purpose: no fetch, no
 * state, so the rule is one unit test rather than a mock.
 */

/**
 * The name to show for a person, given the address the server has for them
 * and the name this device calls itself.
 *
 * Falls through to the device name when there is no address to use, and to
 * a plain word when there is not even that, because every caller is
 * labelling something a person will read and none of them can show nothing.
 */
export function personLabel(email: string, deviceName: string): string {
	const local = (email ?? "").trim().split("@")[0].trim();
	if (local) return local;
	const device = (deviceName ?? "").trim();
	return device || "Someone else";
}

/**
 * What a conflict copy is called: who made it and when.
 *
 * Kept beside the label rather than in `VaultBinding`, because both
 * bindings build one and a copy that says `daniel conflict 2026-09-01` in
 * one place and `conflict 2026-09-01` in the other is the sort of drift
 * nobody notices until they are looking at four files with two names.
 */
export function conflictLabelFor(email: string, deviceName: string, on: Date): string {
	return `${personLabel(email, deviceName)} conflict ${on.toISOString().slice(0, 10)}`;
}
