/**
 * Linking, over a real socket, saying what it is doing while it does it.
 *
 * The complaint this answers: press a cloud vault, the picker closes, and
 * nothing happens for however long the vault takes. It was not hung. The
 * reconciliation was running, and `link` did not resolve until the whole of
 * it had, so the notice saying it had worked arrived minutes after the person
 * had gone looking for what went wrong.
 *
 * Two claims, and they are the two halves of that. The eight steps arrive in
 * order with the right numbers on them, and *Link established* arrives before
 * the fill rather than after it. The third is the word that covers the fill:
 * a vault linked here reads Initializing, and says so until it falls quiet.
 */

import { KnapSync, type KnapLink } from "../../src/knap/KnapSync";
import type { LinkFacts, LinkStep } from "../../src/knap/linkSteps";
import { TREE_DOC_ID, TreeDoc } from "../../src/knap/TreeDoc";
import { INITIALIZING, UP_TO_DATE } from "../../src/syncStatus";
import { FakeNetwork, MemoryFiles } from "../mocks/fakeNetwork";

/** Nothing here asks the server anything but who it is and what it takes. */
const answers = async (url: string) => {
	if (url.endsWith("/api/me")) {
		return new Response(JSON.stringify({ subject: "s1", email: "iris@example.test" }));
	}
	return new Response(
		JSON.stringify({ max_attachment_bytes: 10_000_000, max_vault_bytes: 1_000_000_000 }),
	);
};

/** Put notes and attachments into the cloud vault's tree, from outside. */
function fillCloud(network: FakeNetwork, vaultId: string, notes: string[], files: string[]): void {
	const tree = new TreeDoc(network.doc(`/sync/${vaultId}/${TREE_DOC_ID}`));
	for (const path of notes) tree.ensureNote(path);
	for (const path of files) tree.setAttachment(path, { hash: "abc", size: 1 });
}

function syncOver(network: FakeNetwork, files: MemoryFiles, stored: KnapLink | null) {
	let held = stored;
	const sync = new KnapSync({
		serverUrl: "https://knap.test",
		deviceName: "Laptop",
		fetchFn: answers,
		files,
		load: () => held,
		save: async (value) => {
			held = value;
		},
		webSocket: network.socket,
	});
	return { sync, held: () => held };
}

describe("linking says what it is doing", () => {
	jest.setTimeout(30_000);
	process.setMaxListeners(0);

	it("reports the eight steps in order, with what each one found", async () => {
		const network = new FakeNetwork();
		fillCloud(network, "v1", ["Cloud/a.md", "Shared/b.md"], ["Cloud/photo.png"]);
		// Empty on this side, which is joining a cloud vault somebody added
		// you to. One of the two move rows is always Nothing now (ADR-0098),
		// and this is the half where everything comes down.
		const files = new MemoryFiles();
		const { sync, held } = syncOver(network, files, {
			token: "knap_abc",
			cloudVaultId: "",
			cloudVaultName: "",
		});

		const seen: [LinkStep, LinkFacts][] = [];
		await sync.link({ id: "v1", name: "Work notes" }, (step, facts) =>
			seen.push([step, { ...facts }]),
		);

		expect(seen.map(([step]) => step)).toEqual([
			"connecting",
			"cloudNotes",
			"cloudAttachments",
			"localNotes",
			"localAttachments",
			"toDownload",
			"toUpload",
			"linked",
		]);
		const last = seen[seen.length - 1][1];
		expect(last).toEqual({
			cloudNotes: 2,
			cloudAttachments: 1,
			localNotes: 0,
			localAttachments: 0,
			// Everything up there is up there and not here, the photo too.
			downloadNotes: 2,
			downloadAttachments: 1,
			uploadNotes: 0,
			uploadAttachments: 0,
		});
		// And the link is recorded as one that has not been through a pass.
		expect(held()?.cloudVaultId).toBe("v1");
		expect(held()?.initialized).toBe(false);

		sync.stop();
	});

	it("counts the other half the same way, when the cloud vault is the empty one", async () => {
		const network = new FakeNetwork();
		const files = new MemoryFiles();
		files.map.set("Here/only.md", "# Only here\n");
		files.map.set("Here/second.md", "# Second\n");
		const { sync } = syncOver(network, files, {
			token: "knap_abc",
			cloudVaultId: "",
			cloudVaultName: "",
		});

		let last: LinkFacts = {};
		await sync.link({ id: "v1", name: "Work notes" }, (_step, facts) => {
			last = { ...facts };
		});

		expect(last.uploadNotes).toBe(2);
		expect(last.downloadNotes).toBe(0);

		sync.stop();
	});

	// The third case, and the only one that could lose work: two vaults that
	// both hold notes used to be merged, conflict copies and all (ADR-0098).
	it("refuses a link with notes on both sides, and leaves both of them alone", async () => {
		const network = new FakeNetwork();
		fillCloud(network, "v1", ["Cloud/a.md", "Shared/b.md"], []);
		const files = new MemoryFiles();
		files.map.set("Here/only.md", "# Only here\n");
		const { sync, held } = syncOver(network, files, {
			token: "knap_abc",
			cloudVaultId: "",
			cloudVaultName: "",
		});

		const seen: LinkStep[] = [];
		await expect(
			sync.link({ id: "v1", name: "Work notes" }, (step) => seen.push(step)),
		).rejects.toThrow(/both hold notes/);

		// The counts are all reported, because they are what the refusal is
		// made of and what the person reads. Nothing past them happens.
		expect(seen).toEqual([
			"connecting",
			"cloudNotes",
			"cloudAttachments",
			"localNotes",
			"localAttachments",
		]);
		// Nothing moved, either way, and the link is off again. The sign-in
		// is not: a refused link is not a reason to sign somebody out.
		expect([...files.map.keys()]).toEqual(["Here/only.md"]);
		expect(held()?.cloudVaultId).toBe("");
		expect(held()?.token).toBe("knap_abc");

		sync.stop();
	});

	// The flag that tells a first link from an ordinary start, and the reason
	// it is written down rather than held in memory: quitting Obsidian in the
	// middle of the first pass would otherwise come back as an ordinary
	// start, and push the settings this device was about to give up into
	// everybody else's vault (ADR-0099).
	it("marks the settings pass pending at link time and done at the end of it", async () => {
		const network = new FakeNetwork();
		fillCloud(network, "v1", ["Cloud/a.md"], []);
		const files = new MemoryFiles();
		const { sync, held } = syncOver(network, files, {
			token: "knap_abc",
			cloudVaultId: "",
			cloudVaultName: "",
		});

		let pendingWhenLinked: boolean | undefined;
		await sync.link({ id: "v1", name: "Work notes" }, (step) => {
			if (step === "linked") pendingWhenLinked = held()?.settingsInitialized;
		});

		// False while the fill runs, so a quit in the middle comes back to a
		// first link rather than to a start that uploads.
		expect(pendingWhenLinked).toBe(false);
		expect(held()?.settingsInitialized).toBe(true);

		sync.stop();
	});

	it("says the link is established before the fill, not after it", async () => {
		const network = new FakeNetwork();
		fillCloud(
			network,
			"v1",
			Array.from({ length: 40 }, (_, index) => `Cloud/note-${index}.md`),
			[],
		);
		const files = new MemoryFiles();
		const { sync } = syncOver(network, files, {
			token: "knap_abc",
			cloudVaultId: "",
			cloudVaultName: "",
		});

		let hereWhenLinked = 0;
		await sync.link({ id: "v1", name: "Work notes" }, (step) => {
			if (step === "linked") hereWhenLinked = files.map.size;
		});

		// The whole point: the screen is told at the start of the download,
		// not at the end of it.
		expect(hereWhenLinked).toBe(0);
		expect(files.map.size).toBe(40);

		sync.stop();
	});

	it("reads Initializing through the first pass, and Up to date after it", async () => {
		const network = new FakeNetwork();
		fillCloud(network, "v1", ["Cloud/a.md"], []);
		const files = new MemoryFiles();
		const { sync, held } = syncOver(network, files, {
			token: "knap_abc",
			cloudVaultId: "",
			cloudVaultName: "",
		});

		const words: string[] = [];
		await sync.link({ id: "v1", name: "Work notes" }, (step) => {
			if (step === "linked") words.push(sync.status().word);
		});

		expect(words).toEqual([INITIALIZING]);
		// Once there is nothing left to carry the word gives way, and the
		// settings remember it, so a restart does not say it a second time.
		expect(sync.status().word).toBe(UP_TO_DATE);
		await Promise.resolve();
		expect(held()?.initialized).toBe(true);

		sync.stop();
	});
});
