/**
 * The two lists of words the setup screen owns.
 *
 * Neither of them computes anything, so what is worth pinning is the rules
 * the copy has to keep: no em-dashes anywhere a person reads (CLAUDE.md), and
 * the repository in the one form BRAT accepts. The second is the whole reason
 * `anotherDevice.ts` exists: BRAT's field wants owner and repository, an
 * address pasted into it is rejected, and Knap's page and this screen have to
 * show the same string or the person reading both is being given two answers.
 */

import { describe, test, expect } from "@jest/globals";
import { CHECKLIST, CHECKLIST_TITLE } from "../src/setupChecklist";
import {
	ANOTHER_DEVICE_NOTE,
	ANOTHER_DEVICE_STEPS,
	ANOTHER_DEVICE_TITLE,
	KNAP_PLUGIN_REPO,
	PASTE_LABEL,
} from "../src/anotherDevice";
import { KNAP_PLUGIN_REPO_URL } from "../src/RelayOnPremConfig";

const everything = [
	CHECKLIST_TITLE,
	...CHECKLIST.flatMap((item) => [item.title, item.detail]),
	ANOTHER_DEVICE_TITLE,
	PASTE_LABEL,
	ANOTHER_DEVICE_NOTE,
	...ANOTHER_DEVICE_STEPS,
];

describe("the list somebody reads before starting", () => {
	test("names the two things that cost notes, and says what to do", () => {
		const titles = CHECKLIST.map((item) => item.title.toLowerCase()).join(" ");
		expect(titles).toContain("sync");
		expect(titles).toMatch(/icloud|dropbox|onedrive/);
	});

	test("every line has a reason under it", () => {
		for (const item of CHECKLIST) {
			expect(item.title.trim().length).toBeGreaterThan(0);
			expect(item.detail.trim().length).toBeGreaterThan(0);
		}
	});
});

describe("the next device", () => {
	test("the repository is what BRAT's field takes, not an address", () => {
		expect(KNAP_PLUGIN_REPO).toBe("pantalytics/knap-obsidian");
		expect(KNAP_PLUGIN_REPO).not.toContain("http");
		expect(KNAP_PLUGIN_REPO).not.toContain("github.com");
	});

	test("the address, where there is room for one, is the same repository", () => {
		expect(KNAP_PLUGIN_REPO_URL).toBe(`https://github.com/${KNAP_PLUGIN_REPO}`);
	});

	test("the steps go BRAT, then plugin, then the vault picked off a list", () => {
		expect(ANOTHER_DEVICE_STEPS).toHaveLength(3);
		expect(ANOTHER_DEVICE_STEPS[0]).toContain("BRAT");
		expect(ANOTHER_DEVICE_STEPS[2].toLowerCase()).toContain("pick this vault");
	});

	test("no step spells the repository out inside a sentence", () => {
		// It is a string to paste, and a string to paste in the middle of a
		// line is a string somebody copies half of.
		for (const step of ANOTHER_DEVICE_STEPS) {
			expect(step).not.toContain(KNAP_PLUGIN_REPO);
		}
	});
});

describe("the house rules for copy", () => {
	test("no em-dashes anywhere a person reads", () => {
		for (const line of everything) {
			expect(line).not.toContain("—");
		}
	});
});
