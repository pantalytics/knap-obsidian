/**
 * The two lists of words the setup screen owns.
 *
 * Neither of them computes anything, so what is worth pinning is the rules
 * the copy has to keep: no em-dashes anywhere a person reads (CLAUDE.md), and
 * the next device installs from Community plugins, the only way in (vault
 * ADR-0104).
 */

import { describe, test, expect } from "@jest/globals";
import { CHECKLIST, CHECKLIST_TITLE } from "../src/setupChecklist";
import {
	ANOTHER_DEVICE_NOTE,
	ANOTHER_DEVICE_STEPS,
	ANOTHER_DEVICE_TITLE,
} from "../src/anotherDevice";

const everything = [
	CHECKLIST_TITLE,
	...CHECKLIST.flatMap((item) => [item.title, item.detail]),
	ANOTHER_DEVICE_TITLE,
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
	test("installs from Community plugins, then picks this vault off a list", () => {
		expect(ANOTHER_DEVICE_STEPS).toHaveLength(2);
		expect(ANOTHER_DEVICE_STEPS[0]).toContain("Community plugins");
		expect(ANOTHER_DEVICE_STEPS[1].toLowerCase()).toContain("pick this vault");
	});

	test("never sends anybody to BRAT", () => {
		for (const line of [...ANOTHER_DEVICE_STEPS, ANOTHER_DEVICE_NOTE]) {
			expect(line).not.toContain("BRAT");
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
