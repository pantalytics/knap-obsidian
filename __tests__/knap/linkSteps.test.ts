/**
 * What the linking screen says, as a rule rather than a rendering.
 *
 * The modal is eight rows and a spinner, and none of that is worth pinning.
 * What is worth pinning is that a step is only ever done, running, waiting or
 * failed; that a failure stops the list where it stood; and that the two rows
 * a person actually waits on say *Nothing* rather than a zero.
 */

import {
	LINK_STEPS,
	linkCounts,
	linkRows,
	movePhrase,
	type LinkFacts,
} from "../../src/knap/linkSteps";

const full: LinkFacts = {
	cloudNotes: 1204,
	cloudAttachments: 88,
	localNotes: 1190,
	localAttachments: 80,
	downloadNotes: 14,
	downloadAttachments: 8,
	uploadNotes: 0,
	uploadAttachments: 0,
};

describe("the steps", () => {
	it("starts with the first one running and the rest waiting", () => {
		const rows = linkRows(null, {});
		expect(rows.map((row) => row.state)).toEqual([
			"doing",
			"waiting",
			"waiting",
			"waiting",
			"waiting",
			"waiting",
			"waiting",
			"waiting",
		]);
		expect(rows[0].label).toBe("Connecting");
	});

	it("marks everything up to the last finished step as done", () => {
		const rows = linkRows("cloudAttachments", full);
		expect(rows.slice(0, 3).every((row) => row.state === "done")).toBe(true);
		expect(rows[3].state).toBe("doing");
		expect(rows[4].state).toBe("waiting");
	});

	it("ends with every step done", () => {
		expect(linkRows("linked", full).every((row) => row.state === "done")).toBe(true);
	});

	it("stops the list where it failed, and nothing after it runs", () => {
		const rows = linkRows("connecting", { cloudNotes: 1204 }, true);
		expect(rows[0].state).toBe("done");
		expect(rows[1].state).toBe("failed");
		expect(rows.slice(2).every((row) => row.state === "waiting")).toBe(true);
	});

	it("shows a step's number once it has one, and nothing before", () => {
		expect(linkRows(null, {})[1].value).toBe("");
		expect(linkRows("cloudNotes", full)[1].value).toBe("1,204");
	});

	it("leaves the two acts without a number", () => {
		const rows = linkRows("linked", full);
		expect(rows[0].value).toBe("");
		expect(rows[LINK_STEPS.length - 1].value).toBe("");
	});
});

describe("what has to move", () => {
	it("says both kinds when there are both", () => {
		expect(movePhrase(14, 8)).toBe("14 notes, 8 attachments");
	});

	it("leaves out the kind there is none of, and does not say 0", () => {
		expect(movePhrase(1, 0)).toBe("1 note");
		expect(movePhrase(0, 3)).toBe("3 attachments");
	});

	it("says Nothing rather than a zero, because that is the answer", () => {
		expect(movePhrase(0, 0)).toBe("Nothing");
	});

	it("counts each side against the other", () => {
		expect(
			linkCounts(
				{ notes: ["a.md", "b.md"], attachments: ["p.png"] },
				{ notes: ["b.md", "c.md"], attachments: [] },
			),
		).toEqual({
			downloadNotes: 1,
			downloadAttachments: 1,
			uploadNotes: 1,
			uploadAttachments: 0,
		});
	});

	it("has nothing to move between two sides that match", () => {
		const both = { notes: ["a.md"], attachments: ["p.png"] };
		const counts = linkCounts(both, both);
		expect(movePhrase(counts.downloadNotes, counts.downloadAttachments)).toBe("Nothing");
		expect(movePhrase(counts.uploadNotes, counts.uploadAttachments)).toBe("Nothing");
	});
});
