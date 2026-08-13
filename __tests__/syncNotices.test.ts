/**
 * What Sync vault says, and what it may never say.
 *
 * The failure this file exists to keep out is the pair of notices somebody
 * got on 2026-08-13: *Syncing all shares...* and *No shares to sync*, one
 * above the other in the corner, over a vault that was syncing. So the
 * assertions below are mostly about the two of them agreeing, and about the
 * word "share" never reaching a screen (ADR-0038).
 */

import { PAUSED, SIGNED_OUT } from "../src/syncStatus";
import {
	planVaultSync,
	vaultSyncResult,
	type VaultSyncWork,
} from "../src/syncNotices";

/** A vault syncing whole, which is every ordinary vault (ADR-0043). */
const vault: VaultSyncWork = {
	connected: true,
	folders: 1,
	pausedFolders: 0,
	webShares: 0,
};
/** Signed in, and nothing shared here yet. */
const nothing: VaultSyncWork = { ...vault, folders: 0 };
/** The vault is here and switched off on this device. */
const paused: VaultSyncWork = { ...nothing, pausedFolders: 1 };
/** No client, which is what being signed out looks like from here. */
const signedOut: VaultSyncWork = { ...vault, connected: false };

/** Every notice either function can produce, for the whole-file assertions. */
const everyNotice = (): string[] => {
	const works = [vault, nothing, paused, signedOut, { ...vault, webShares: 2 }];
	return [
		...works.map((work) => planVaultSync(work).notice),
		...works.flatMap((work) => [0, 1, 2].map((sent) => vaultSyncResult(work, sent))),
	];
};

describe("whether there is anything to sync", () => {
	test("a vault this device holds is work, and it says so once", () => {
		const plan = planVaultSync(vault);
		expect(plan.start).toBe(true);
		expect(plan.notice).toBe("Syncing this vault...");
	});

	test("a published file with no vault behind it is work, and says which", () => {
		const plan = planVaultSync({ ...nothing, webShares: 1 });
		expect(plan.start).toBe(true);
		expect(plan.notice).toBe("Sending your published files...");
	});

	test("no client is Signed out, in the words the screen uses", () => {
		const plan = planVaultSync(signedOut);
		expect(plan.start).toBe(false);
		expect(plan.notice).toContain(SIGNED_OUT);
		expect(plan.notice).toContain("still on this device");
	});

	test("a vault switched off here is Paused, not nothing", () => {
		const plan = planVaultSync(paused);
		expect(plan.start).toBe(false);
		expect(plan.notice).toContain(PAUSED);
	});

	test("nothing set up says what to do about it", () => {
		const plan = planVaultSync(nothing);
		expect(plan.start).toBe(false);
		expect(plan.notice).toBe(
			"This vault is not syncing yet. Open Knap in settings to set it up.",
		);
	});

	test("nothing to do never announces that it is syncing", () => {
		for (const work of [nothing, paused, signedOut]) {
			const plan = planVaultSync(work);
			expect(plan.start).toBe(false);
			expect(plan.notice.toLowerCase()).not.toContain("syncing this vault");
		}
	});
});

describe("what it says afterwards", () => {
	test("the vault is syncing, not synced: the notes go up behind this", () => {
		const notice = vaultSyncResult(vault, 0);
		expect(notice).toContain("Syncing this vault.");
		expect(notice).toContain("Leave Obsidian open");
	});

	test("published files are counted, and counted in English", () => {
		expect(vaultSyncResult(nothing, 1)).toBe("Sent 1 published file.");
		expect(vaultSyncResult(nothing, 2)).toBe("Sent 2 published files.");
		expect(vaultSyncResult(vault, 2)).toContain("Sent 2 published files.");
	});

	test("nothing sent and nothing syncing says so plainly", () => {
		expect(vaultSyncResult(nothing, 0)).toBe(
			"Nothing was sent. The published files may no longer be in this vault.",
		);
	});
});

describe("the words that may reach a person", () => {
	test("never share, in any notice this file can produce", () => {
		for (const notice of everyNotice()) {
			expect(notice.toLowerCase()).not.toContain("share");
		}
	});

	test("no notice contradicts itself about whether anything is happening", () => {
		for (const work of [vault, nothing, paused, signedOut]) {
			const plan = planVaultSync(work);
			if (!plan.start) continue;
			// Whatever the work turns out to be, the closing notice may not
			// come back saying there was none of it.
			for (const sent of [0, 1]) {
				expect(vaultSyncResult(work, sent)).not.toContain("Nothing was sent");
			}
		}
	});
});
