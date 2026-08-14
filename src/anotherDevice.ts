"use strict";

/**
 * How Knap goes on the next device, said at the end rather than at the start.
 *
 * A vault that is syncing is the moment somebody wants their phone on it too,
 * and until now the plugin said nothing about that: the steps lived on Knap's
 * page, which is a browser on the machine where the job is in another app.
 * The one they get stuck on is the second, because BRAT asks for a
 * "Repository" and the panel showed an address, so people paste
 * `https://github.com/pantalytics/knap-obsidian` into a field that wants
 * `pantalytics/knap-obsidian`.
 *
 * So the string to paste is its own thing here, not a sentence with a
 * repository somewhere inside it. `KNAP_PLUGIN_REPO` is the one form that
 * works, and it is the same constant Knap's page renders.
 *
 * Plain data, no Obsidian imports, so the copy can be pinned in a test.
 */

import { KNAP_PLUGIN_REPO } from "./RelayOnPremConfig";

export const ANOTHER_DEVICE_TITLE = "Add another device";

/** What the field on the next device wants, above the string itself. */
export const PASTE_LABEL = "Paste this into BRAT";

/**
 * The steps, in the order Obsidian asks for them.
 *
 * Three, and the third is the whole of what a second device is: the same
 * account, then the same cloud vault picked off the list. Nothing to name and
 * nothing to type correctly, which is what the picker (#55) is for.
 *
 * BRAT rather than Browse, because Knap is not in the community catalogue: a
 * search there finds nothing, or finds the plugin Knap was forked from and
 * installs the wrong one.
 */
export const ANOTHER_DEVICE_STEPS: readonly string[] = [
	"On the other device: Settings, Community plugins, Browse, and install BRAT.",
	"Settings, BRAT, Add beta plugin. Paste the line below, then enable Knap.",
	"Settings, Knap, Sign in with the same account, then pick this vault from the list.",
];

/** The one line about what does not travel with the notes. */
export const ANOTHER_DEVICE_NOTE =
	"The notes come across on their own. Themes, plugins and settings stay on the device they are installed on.";

export { KNAP_PLUGIN_REPO };
