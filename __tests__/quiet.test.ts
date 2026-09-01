/**
 * The two seconds at each end of the corner of the window.
 *
 * The bug this is here for is not a wrong number, it is a mark that moves all
 * day: saving a note pushed its document, which put the vault into Syncing,
 * which grew a count and a bar, all inside a second, every time (ADR-0086).
 */

import {
	QUIET_MS,
	RUNNING,
	STILL,
	backlogLabel,
	backlogText,
	burstProgress,
	settle,
} from "../src/quiet";

describe("what the corner waits for", () => {
	test("an ordinary save never reaches the screen", () => {
		let burst = STILL;
		// A note is saved: the vault is moving, and stops well inside the wait.
		burst = settle(burst, true, 1, 1_000);
		expect(burst.moving).toBe(false);
		burst = settle(burst, true, 1, 1_400);
		expect(burst.moving).toBe(false);
		burst = settle(burst, false, 0, 1_800);
		expect(burst.moving).toBe(false);
		// And the pending flip is dropped rather than remembered, so the next
		// save starts its own two seconds instead of inheriting these.
		expect(burst.since).toBeNull();
	});

	test("a real sync gets said, two seconds in", () => {
		let burst = settle(STILL, true, 2567, 0);
		expect(burst.moving).toBe(false);
		burst = settle(burst, true, 2567, QUIET_MS - 1);
		expect(burst.moving).toBe(false);
		burst = settle(burst, true, 2500, QUIET_MS);
		expect(burst.moving).toBe(true);
	});

	test("up to date is held for two seconds after the last note lands", () => {
		let burst = { moving: true, since: null, peak: 2567 };
		burst = settle(burst, false, 0, 10_000);
		expect(burst.moving).toBe(true);
		burst = settle(burst, false, 0, 10_000 + QUIET_MS);
		expect(burst.moving).toBe(false);
		expect(burst.peak).toBe(0);
	});

	test("the bar fills against what the burst started with, not what is left", () => {
		// The vault only ever knows how many notes are still to come, and a
		// bar drawn against a shrinking total never moves.
		let burst = settle(STILL, true, 1000, 0);
		burst = settle(burst, true, 1000, QUIET_MS);
		expect(burst.peak).toBe(1000);
		expect(burstProgress(burst, 750)).toBeCloseTo(0.25);
		// A vault that grows mid-burst raises the mark rather than overflowing.
		burst = settle(burst, true, 1500, QUIET_MS + 1);
		expect(burst.peak).toBe(1500);
		expect(burstProgress(burst, 1500)).toBe(0);
	});

	test("nothing is drawn against a burst that is not running", () => {
		expect(burstProgress(STILL, 0)).toBeUndefined();
		expect(burstProgress(RUNNING, 12)).toBeUndefined();
	});
});

describe("the two numbers", () => {
	test("both directions, either alone, or neither", () => {
		expect(backlogText(412, 2567)).toBe("↑ 412 ↓ 2,567");
		expect(backlogText(412, 0)).toBe("↑ 412");
		expect(backlogText(0, 2567)).toBe("↓ 2,567");
		expect(backlogText(0, 0)).toBe("");
	});

	test("said out loud in the words that already exist", () => {
		// vault, cloud vault and device are on the list a screen may use;
		// upload, download and sync direction are not.
		expect(backlogLabel(412, 2567)).toBe("412 to the cloud vault, 2,567 to this device");
		expect(backlogLabel(0, 3)).toBe("3 to this device");
		expect(backlogLabel(0, 0)).toBe("");
	});
});
