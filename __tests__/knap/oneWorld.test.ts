/**
 * A beta build is one world.
 *
 * The first beta pointed at the rebuilt server and still carried the relay:
 * its settings tab listed the shares of the stack this build exists to
 * replace, as "cloud vaults", beside the real ones and with nothing on either
 * screen saying which server it was talking about. Worse than confusing --
 * the relay's background sync was also running, so the old stack's shares
 * were being synced into whatever vault the beta was installed in.
 *
 * These read main.ts rather than driving the plugin, because standing a whole
 * Obsidian up in jest to assert three `if`s is a slower test that proves less.
 * What matters is that each of the three guards exists and reads the same
 * flag; whether the plugin honours it is what the real-app walk is for.
 */

import { readFileSync } from "fs";
import { join } from "path";

const main = readFileSync(join(__dirname, "..", "..", "src", "main.ts"), "utf8");

/** The line and everything after it, up to the closing brace of the guard. */
function guardAround(needle: string): string {
	const at = main.indexOf(needle);
	expect(at).toBeGreaterThan(-1);
	return main.slice(Math.max(0, at - 400), at + needle.length);
}

describe("a beta build does not also run the relay", () => {
	it("does not add the relay's settings tab", () => {
		expect(guardAround("this.addSettingTab(this.settingsTab);")).toMatch(
			/if \(!this\.knapSync\) \{/,
		);
	});

	it("does not start the relay's background sync", () => {
		expect(guardAround("this.backgroundSync.start();")).toMatch(/if \(!this\.knapSync\) \{/);
	});

	it("does not load shares from the old control plane", () => {
		const body = main.slice(main.indexOf("private async loadRelayOnPremShares"));
		expect(body.slice(0, 800)).toMatch(/if \(this\.knapSync\) \{[\s\S]*?return;/);
	});

	it("cannot take the rest of onload down with it", () => {
		// registerKnapBeta runs early in onload; the ribbon icon is registered
		// eighty lines later. A throw in here once meant no icon at all, and
		// nothing on screen saying why.
		const at = main.indexOf("registerKnapBeta(this)");
		expect(at).toBeGreaterThan(-1);
		const around = main.slice(at - 200, at + 300);
		expect(around).toMatch(/try \{/);
		expect(around).toMatch(/catch \(error\)/);
	});

	it("leaves an ordinary build alone: the flag is null without a server url", () => {
		const registrar = readFileSync(
			join(__dirname, "..", "..", "src", "knap", "ObsidianKnap.ts"),
			"utf8",
		);
		expect(registrar).toMatch(/if \(!serverUrl\) \{\s*return null;/);
	});
});
