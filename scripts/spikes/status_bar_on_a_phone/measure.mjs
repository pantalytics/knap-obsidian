/**
 * Is anything in the status bar's head outside its card on a phone?
 *
 * Renders the head as KnapSettingsTab.drawStatus() builds it, against the real
 * styles.css, in a card the width Obsidian's settings sheet gives it at 390px.
 * Obsidian's own font sizes are the app's rather than ours and there is no
 * Obsidian here to read them from, so they are swept and every size has to
 * pass. See README.md for what this settled and what it cannot know.
 *
 * Exit codes: 0 nothing is cut, 1 something is, 2 the environment is not there.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = join(HERE, "..", "..", "..", "styles.css");

let chromium;
try {
	({ chromium } = await import("playwright-core"));
} catch {
	console.error("playwright-core is not installed. This spike installs nothing; see README.md.");
	process.exit(2);
}

/** The name from the #125 screenshot. A short one hides the bug. */
const VAULT = "260812_RH_Obsidian_vault";
const COUNT = "1,368 notes";

/** Obsidian's tokens, as far as they matter to this row. */
const tokens = (base, small) => `
:root {
  --size-2-2:4px; --size-2-3:6px;
  --size-4-1:4px; --size-4-2:8px; --size-4-3:12px; --size-4-4:16px;
  --font-ui-smaller:${small - 1}px; --font-ui-small:${small}px; --font-semibold:600;
  --radius-m:8px; --icon-s:16px;
  --text-normal:#222; --text-muted:#666; --text-faint:#999;
  --background-secondary:#f2f3f5; --background-modifier-border:#ddd;
  --background-modifier-hover:rgba(0,0,0,.075);
  --color-green:#0a0; --color-yellow:#ca0; --color-red:#c00; --interactive-accent:#7b6cd9;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, sans-serif; font-size: ${base}px; }
/* Obsidian sets this on its buttons, and the head is one whenever it folds. */
button { white-space: nowrap; }
/* The settings sheet on a 390px screen, 16px either side. */
#sheet { width: 358px; }
`;

/** The head with a fold behind it, which is the wider of the two shapes. */
const HEAD = `<div id="sheet"><div class="knap-status">
 <button type="button" class="knap-status-head knap-status-opens" aria-expanded="false"
  ><span class="knap-dot knap-dot-ok"></span
  ><span class="knap-status-word">Syncing</span
  ><span class="knap-status-detail"
    ><span class="knap-status-vault">${VAULT}</span
    ><span class="knap-status-count">${COUNT}</span
  ></span
  ><span class="knap-status-chevron"></span
 ></button>
 <div class="knap-status-body" hidden></div>
</div></div>`;

const css = readFileSync(STYLES, "utf8");

// Whichever Chromium is on the machine. A spike installs nothing, so it takes
// the one Playwright manages if the versions happen to line up, and otherwise
// the one named in KNAP_CHROMIUM. Neither is this plugin's dependency.
async function launch() {
	try {
		return await chromium.launch();
	} catch (first) {
		if (!process.env.KNAP_CHROMIUM) {
			console.error(String(first).split("\n")[0]);
			console.error("No Chromium. Set KNAP_CHROMIUM to one, or run npx playwright install.");
			process.exit(2);
		}
		return chromium.launch({ executablePath: process.env.KNAP_CHROMIUM });
	}
}

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

/** Everything the card would clip, in whole pixels. */
async function probe(base, small) {
	await page.setContent(`<style>${tokens(base, small)}\n${css}</style>${HEAD}`);
	return page.evaluate(() => {
		const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
		const card = rect(".knap-status");
		const head = document.querySelector(".knap-status-head");
		const last = rect(".knap-status-chevron") ?? rect(".knap-status-count");
		return {
			cutLeft: Math.round(Math.max(0, card.left - rect(".knap-dot").left)),
			cutRight: Math.round(Math.max(0, last.right - card.right)),
			overflow: Math.round(head.scrollWidth - head.clientWidth),
			countShown: Math.round(rect(".knap-status-count").width) > 0,
		};
	});
}

// From a desktop-ish size up through where a phone actually sits. The bug this
// spike exists for only appears from about 15px, so a single small size proves
// nothing.
const SIZES = [
	[16, 13],
	[16, 15],
	[17, 15],
	[17, 16],
	[18, 16],
	[18, 17],
	[19, 17],
];

const failures = [];
console.log("base/small   cut left   cut right   overflow   count shown");
for (const [base, small] of SIZES) {
	const out = await probe(base, small);
	console.log(
		`${base}/${small}` +
			`${String(out.cutLeft).padStart(11)}` +
			`${String(out.cutRight).padStart(12)}` +
			`${String(out.overflow).padStart(11)}` +
			`${String(out.countShown).padStart(14)}`,
	);
	if (out.cutLeft > 0) failures.push(`${base}/${small}: the dot is ${out.cutLeft}px outside`);
	if (out.cutRight > 0) failures.push(`${base}/${small}: the row is ${out.cutRight}px outside`);
	if (!out.countShown) failures.push(`${base}/${small}: the count has no width left`);
}

await browser.close();

if (failures.length) {
	console.error("\nFAIL");
	for (const line of failures) console.error(`  ${line}`);
	process.exit(1);
}
console.log("\nPASS: nothing is outside the card, at any size in the sweep");
