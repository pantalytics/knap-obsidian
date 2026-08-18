/**
 * What a Kanban board's save does, which nothing tested before (#81).
 *
 * `TextFileViewPlugin` patches `requestSave` on the view instance, and Kanban's
 * board view is a `TextFileView` with `"kanban"` in `ALLOWED_TEXT_FILE_VIEWS`,
 * so a board does get a real view plugin. The hole was never that the patch is
 * missing. It is that the patch only puts the board into the Y.Text when the
 * view is already `tracking`, and `tracking` starts false and is only set at
 * the end of `resync()`, which awaits `whenSynced()`. Kanban re-serialises the
 * board on open, which is exactly when that window is open: the bytes went to
 * the file and nowhere else.
 *
 * The first two tests pin the patch's own behaviour. The third is the hole, and
 * it is closed by the write itself being carried in rather than by anything
 * here changing.
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";

jest.mock("src/storage/y-indexeddb", () => ({
	IndexeddbPersistence: class {},
}));
jest.mock("pocketbase", () => ({
	__esModule: true,
	default: class {},
	BaseAuthStore: class {},
}));

/**
 * `isLive` is an instanceof check against `LiveView`, and the real module
 * reaches CodeMirror and Svelte on the way in. A stand-in class keeps the
 * check honest without any of that.
 */
class FakeLiveView {}
jest.mock("src/LiveViews", () => ({
	LiveView: FakeLiveView,
	isLive: (view: unknown) => view instanceof FakeLiveView,
}));
jest.mock("src/plugins/ViewHookPlugin", () => ({
	ViewHookPlugin: class {
		initialize() {
			return Promise.resolve();
		}
		destroy() {
			/* nothing to clean up */
		}
	},
}));

import * as Y from "yjs";
import { TextFileView } from "obsidian";
import { TextFileViewPlugin } from "src/TextViewPlugin";
import { Document } from "src/Document";

const BOARD = "---\n\nkanban-plugin: board\n\n---\n\n## Todo\n\n- [ ] a\n";

class KanbanView extends TextFileView {
	/** Stands in for Obsidian's own save, which writes the file. */
	originalSaves = 0;
	override getViewType(): string {
		return "kanban";
	}
	override requestSave(): void {
		this.originalSaves++;
	}
}

interface Rig {
	view: KanbanView;
	doc: Document;
	plugin: TextFileViewPlugin;
	live: { view: KanbanView; document: Document; tracking: boolean };
}

function makeRig(text: string): Rig {
	const ydoc = new Y.Doc();
	ydoc.getText("contents").insert(0, text);

	const tfile = { path: "Todo Kanban.md" };
	const doc = Object.create(Document.prototype) as Document;
	Object.assign(doc, {
		path: "Todo Kanban.md",
		guid: "board-guid",
		ydoc,
		_tfile: tfile,
		_ownWriteDepth: 0,
		_ownWriteUntil: 0,
		_parent: { isPendingDelete: () => false },
		vault: { modify: () => Promise.resolve() },
		// resync() parks here forever. It is not what these tests are about,
		// and letting it run would have it rewrite the view and set tracking
		// underneath the assertions.
		whenSynced: () => new Promise<void>(() => undefined),
		checkStale: () => Promise.resolve(false),
		hasLocalDB: () => true,
		warn: () => undefined,
		debug: () => undefined,
		log: () => undefined,
		error: () => undefined,
	});

	const view = new KanbanView();
	view.file = tfile as never;
	view.data = text;

	const live = Object.assign(new FakeLiveView(), {
		view,
		document: doc,
		tracking: false,
		connectionManager: { sharedFolders: { lookup: () => undefined } },
		checkStale: () => Promise.resolve(false),
	}) as unknown as Rig["live"];

	const plugin = new TextFileViewPlugin(live as never);
	return { view, doc, plugin, live };
}

describe("a board whose view is tracking", () => {
	let rig: Rig;

	beforeEach(() => {
		rig = makeRig(BOARD);
		rig.live.tracking = true;
	});

	test("puts the board into the note and does not fall through to the file", () => {
		rig.view.data = BOARD + "- [ ] added by the board\n";

		rig.view.requestSave();

		expect(rig.doc.ydoc.getText("contents").toJSON()).toBe(rig.view.data);
		expect(rig.view.originalSaves).toBe(0);
	});
});

describe("a board whose view is not tracking yet", () => {
	let rig: Rig;

	beforeEach(() => {
		rig = makeRig(BOARD);
		rig.live.tracking = false;
	});

	/**
	 * Pinned rather than endorsed. This is the window Kanban re-serialises in,
	 * and everything the plugin does about it here is a fire-and-forget resync
	 * plus the original save.
	 */
	test("leaves the note alone and lets the file be written", () => {
		rig.view.data = BOARD + "- [ ] added by the board\n";

		rig.view.requestSave();

		expect(rig.doc.ydoc.getText("contents").toJSON()).toBe(BOARD);
		expect(rig.view.originalSaves).toBe(1);
	});

	/**
	 * And this is the fix: the file write that follows is carried into the note
	 * on its own account, with no view, no tracking flag and no socket involved.
	 */
	test("the file write that follows is carried into the note", () => {
		const written = BOARD + "- [ ] added by the board\n";
		rig.view.data = written;
		rig.doc.markAgreed();

		rig.view.requestSave();
		const decision = rig.doc.carryDiskWrite(written);

		expect(decision.verdict).toBe("carry");
		expect(rig.doc.ydoc.getText("contents").toJSON()).toBe(written);
	});

	test("a serialisation that drops the opening fence is not carried", () => {
		const written = BOARD.slice(8);
		rig.view.data = written;
		rig.doc.markAgreed();

		rig.view.requestSave();
		const decision = rig.doc.carryDiskWrite(written);

		expect(decision.verdict).toBe("refuse");
		expect(rig.doc.ydoc.getText("contents").toJSON()).toBe(BOARD);
	});
});

describe("the patch itself", () => {
	test("comes off cleanly, so a closed board leaves nothing behind", () => {
		const rig = makeRig(BOARD);
		rig.plugin.destroy();

		rig.view.data = BOARD + "- [ ] after the board closed\n";
		rig.view.requestSave();

		expect(rig.view.originalSaves).toBe(1);
	});
});
