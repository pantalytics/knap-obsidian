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
		const files = new MemoryFiles();
		files.map.set("Cloud/a.md", "# A\n");
		files.map.set("Here/only.md", "# Only here\n");
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
			localNotes: 2,
			localAttachments: 0,
			// Shared/b.md is up there and not here; the photo likewise.
			downloadNotes: 1,
			downloadAttachments: 1,
			// Here/only.md is here and not up there.
			uploadNotes: 1,
			uploadAttachments: 0,
		});
		// And the link is recorded as one that has not been through a pass.
		expect(held()?.cloudVaultId).toBe("v1");
		expect(held()?.initialized).toBe(false);

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
