/**
 * Two rows and a bar, and each of them says the right thing in each state.
 *
 * The screen exists because the commands were the only way in, and somebody
 * asked to try the beta opens Settings first. What is pinned here is the shape
 * it settled on: no Change button, no Problems row, and a bar whose detail is
 * folded away until it is asked for.
 */

import {
	KnapSettingsTab,
	hasRetry,
	signOutNotice,
	statusFacts,
} from "../../src/knap/KnapSettingsTab";
import { OFFLINE, PROBLEM, SIGNED_OUT, SYNCING, UP_TO_DATE } from "../../src/syncStatus";

type Row = {
	name: string;
	desc: string;
	buttons: string[];
	disabled: boolean;
	press?: () => void;
};

/** Whatever the screen built by hand, flattened to what it says and does. */
interface FakeEl {
	cls: string;
	text: string;
	hidden: boolean;
	type?: string;
	children: FakeEl[];
	attrs: Record<string, string>;
	listeners: Array<() => void>;
	createDiv(spec?: { cls?: string; text?: string }): FakeEl;
	createSpan(spec?: { cls?: string; text?: string }): FakeEl;
	createEl(tag: string, spec?: { cls?: string; text?: string }): FakeEl;
	addClass(cls: string): void;
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	addEventListener(name: string, run: () => void): void;
	insertBefore(node: FakeEl, before: FakeEl): void;
	setText(text: string): void;
}

function el(cls = "", text = ""): FakeEl {
	const node: FakeEl = {
		cls,
		text,
		hidden: false,
		children: [],
		attrs: {},
		listeners: [],
		createDiv: (spec = {}) => {
			const child = el(spec.cls ?? "", spec.text ?? "");
			node.children.push(child);
			return child;
		},
		createSpan: (spec = {}) => node.createDiv(spec),
		createEl: (_tag, spec = {}) => node.createDiv(spec),
		addClass: (added) => {
			node.cls = `${node.cls} ${added}`.trim();
		},
		setAttribute: (name, value) => {
			node.attrs[name] = value;
		},
		getAttribute: (name) => node.attrs[name] ?? null,
		addEventListener: (_name, run) => node.listeners.push(run),
		setText: (text) => {
			node.text = text;
		},
		insertBefore: (child, before) => {
			const from = node.children.indexOf(child);
			if (from >= 0) node.children.splice(from, 1);
			const at = node.children.indexOf(before);
			node.children.splice(at < 0 ? node.children.length : at, 0, child);
		},
	};
	return node;
}

/** Every node under one, so a test can look for a class without walking. */
function flatten(node: FakeEl): FakeEl[] {
	return [node, ...node.children.flatMap(flatten)];
}

function find(root: FakeEl, cls: string): FakeEl | undefined {
	return flatten(root).find((node) => node.cls.split(" ").includes(cls));
}

jest.mock("obsidian", () => {
	class Setting {
		private row: Row = { name: "", desc: "", buttons: [], disabled: false };
		constructor(container: { rows?: Row[] }) {
			container.rows?.push(this.row);
		}
		setName(name: string) {
			this.row.name = name;
			return this;
		}
		setDesc(desc: string) {
			this.row.desc = desc;
			return this;
		}
		setHeading() {
			return this;
		}
		addButton(build: (b: unknown) => void) {
			const button = {
				setButtonText: (text: string) => {
					this.row.buttons.push(text);
					return button;
				},
				setCta: () => button,
				setDisabled: (off: boolean) => {
					this.row.disabled = off;
					return button;
				},
				onClick: (run: () => void) => {
					this.row.press = run;
					return button;
				},
			};
			build(button);
			return this;
		}
	}
	class PluginSettingTab {
		containerEl: unknown;
		constructor(
			public app: unknown,
			public plugin: unknown,
		) {}
	}
	return { Setting, PluginSettingTab, Notice: class {}, App: class {} };
});

interface FakeState {
	signedIn: boolean;
	linked: null | { id: string; name: string };
	/** The cloud vault a link is being made to right now, as the tab reads it. */
	linking?: string;
	status?: Partial<ReturnType<typeof baseStatus>>;
}

function baseStatus() {
	return {
		word: UP_TO_DATE as string,
		dot: "ok" as string,
		vaultName: "",
		notes: 0,
		problems: 0,
	};
}

/** A stand-in KnapSync that remembers whether it was signed out. */
function fakeSync(state: FakeState) {
	let signedIn = state.signedIn;
	let linked = state.linked;
	const retried: string[] = [];
	const watchers = new Set<() => void>();
	return {
		retried,
		watchers,
		get signedIn() {
			return signedIn;
		},
		get linking() {
			return state.linking ?? "";
		},
		onChange: (watcher: () => void) => {
			watchers.add(watcher);
			return () => {
				watchers.delete(watcher);
			};
		},
		get linked() {
			return linked
				? { cloudVaultId: linked.id, cloudVaultName: linked.name, token: "t" }
				: null;
		},
		status: () => ({
			...baseStatus(),
			// The one thing this stand-in decides for itself, because the page
			// reads the word to tell a redraw from a number that moved.
			word: signedIn ? UP_TO_DATE : SIGNED_OUT,
			vaultName: linked?.name ?? "",
			...(state.status ?? {}),
		}),
		retry: async () => {
			retried.push("retry");
		},
		/** What the picker does, as far as this screen can tell. */
		link: (vault: { id: string; name: string }) => {
			linked = vault;
			state.linking = "";
		},
		unlink: async () => {
			linked = null;
		},
		signOut: async () => {
			signedIn = false;
			linked = null;
			return { endedRemotely: true };
		},
	};
}

/** Pages that are still open, so each test closes what it drew. */
const open: KnapSettingsTab[] = [];

afterEach(() => {
	// The page keeps a subscription and a beat while it is on screen, and a
	// test that leaves one behind leaves a timer running in the worker.
	while (open.length) open.pop()?.hide();
});

function drawWith(sync: ReturnType<typeof fakeSync>) {
	const rows: Row[] = [];
	const container = Object.assign(el("container"), {
		rows,
		empty: () => {
			rows.splice(0, rows.length);
		},
	});
	const plugin = { app: {} };
	const actions = { signIn: async () => {}, pickAndLink: async () => {} };
	const tab = new KnapSettingsTab(
		plugin as never,
		sync as never,
		actions as never,
		"https://next.knap.test",
	);
	tab.containerEl = container as never;
	tab.display();
	open.push(tab);
	return { rows, tab, container: container as unknown as FakeEl };
}

function drawFor(state: FakeState) {
	return drawWith(fakeSync(state));
}

describe("the screen, signed out", () => {
	it("offers signing in and nothing else", () => {
		const { rows } = drawFor({ signedIn: false, linked: null });
		expect(rows.flatMap((r) => r.buttons)).toEqual(["Sign in"]);
	});

	it("names the server this build talks to, without its scheme", () => {
		const { container } = drawFor({ signedIn: false, linked: null });
		expect(find(container, "knap-server")?.text).toBe("next.knap.test");
	});

	it("draws no status bar, because there is nothing to report yet", () => {
		const { container } = drawFor({ signedIn: false, linked: null });
		expect(find(container, "knap-status")).toBeUndefined();
	});
});

describe("the screen, signed in", () => {
	it("offers choosing a cloud vault, and no unlink yet", () => {
		const { rows } = drawFor({ signedIn: true, linked: null });
		expect(rows.flatMap((r) => r.buttons)).toContain("Choose...");
		expect(rows.flatMap((r) => r.buttons)).not.toContain("Unlink");
		expect(rows.find((r) => r.name === "Cloud vault")?.desc).toContain("Not linked");
	});

	it("names the linked vault and offers only unlink beside it", () => {
		// No Change: linking somewhere else is Unlink and then Choose, which
		// is what happens underneath either way.
		const { rows } = drawFor({ signedIn: true, linked: { id: "v1", name: "Work notes" } });
		const vault = rows.find((r) => r.name === "Cloud vault");
		expect(vault?.desc).toContain("Work notes");
		expect(vault?.buttons).toEqual(["Unlink"]);
	});

	it("still says a delete travels both ways, which the shortening did not touch", () => {
		// #116 put this here, and a person deleting a note is entitled to know
		// it goes on both sides. It is a warning rather than an explanation, so
		// it stays on the row instead of moving behind the fold.
		const { rows } = drawFor({ signedIn: true, linked: { id: "v1", name: "Work notes" } });
		expect(rows.find((r) => r.name === "Cloud vault")?.desc).toContain("deletes it in the");
	});

	it("has no row for problems, in any state", () => {
		for (const problems of [0, 3]) {
			const { rows } = drawFor({
				signedIn: true,
				linked: { id: "v1", name: "Work notes" },
				status: { problems, word: problems ? PROBLEM : UP_TO_DATE, dot: "error" },
			});
			expect(rows.map((r) => r.name)).toEqual(["Account", "Cloud vault"]);
		}
	});

	it("offers a way back out in both signed-in states", () => {
		for (const linked of [null, { id: "v1", name: "Work notes" }]) {
			const { rows } = drawFor({ signedIn: true, linked });
			expect(rows.find((r) => r.name === "Account")?.buttons).toEqual(["Sign out"]);
		}
	});

	it("signs out when the button is pressed, and comes back offering sign in", async () => {
		const sync = fakeSync({ signedIn: true, linked: { id: "v1", name: "Work notes" } });
		const { rows } = drawWith(sync);

		rows.find((r) => r.name === "Account")?.press?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(rows.flatMap((r) => r.buttons)).toEqual(["Sign in"]);
		expect(rows.map((r) => r.desc).join(" ")).not.toContain("Work notes");
	});
});

describe("the screen, while a link is being made", () => {
	it("says which cloud vault it is linking to, and offers nothing to press", () => {
		// The state this screen was worst at. A person chose a vault, the page
		// went on saying Not linked, and pressing it again took the first
		// attempt down half way (ADR-0086).
		const { rows } = drawFor({
			signedIn: true,
			linked: null,
			linking: "Work notes",
			status: { word: SYNCING, dot: "working", vaultName: "Work notes" },
		});
		const vault = rows.find((r) => r.name === "Cloud vault");
		expect(vault?.desc).toContain("Linking to Work notes");
		expect(vault?.buttons).toEqual(["Linking..."]);
		expect(vault?.disabled).toBe(true);
	});

	it("turns the dot, which is the whole point of it on a phone", () => {
		const { container } = drawFor({
			signedIn: true,
			linked: null,
			linking: "Work notes",
			status: { word: SYNCING, dot: "working", vaultName: "Work notes" },
		});
		// The turning is CSS on this class, so what a test can pin is that the
		// bar wears it while the link is on its way up.
		expect(find(container, "knap-dot-working")).toBeDefined();
	});
});

describe("the page keeps looking", () => {
	it("redraws itself when the sync says something changed", () => {
		const sync = fakeSync({ signedIn: true, linked: null, linking: "Work notes" });
		const { rows } = drawWith(sync);
		expect(rows.find((r) => r.name === "Cloud vault")?.buttons).toEqual(["Linking..."]);

		// The link came up while the page was open, which is the case the
		// press that started it cannot redraw for.
		sync.link({ id: "v1", name: "Work notes" });
		sync.watchers.forEach((watcher) => watcher());

		const vault = rows.find((r) => r.name === "Cloud vault");
		expect(vault?.desc).toContain("Work notes");
		expect(vault?.buttons).toEqual(["Unlink"]);
	});

	it("stops looking once the page is gone", () => {
		const sync = fakeSync({ signedIn: true, linked: null });
		const { tab } = drawWith(sync);
		expect(sync.watchers.size).toBe(1);
		tab.hide();
		expect(sync.watchers.size).toBe(0);
	});

	it("leaves a page with no bar on it alone", () => {
		// Signed out there is no bar to write a number into, and a beat that
		// compared against a word this page never drew would redraw it once a
		// second for as long as somebody left the tab open.
		jest.useFakeTimers();
		try {
			const { container } = drawFor({ signedIn: false, linked: null });
			const lines = () =>
				flatten(container).filter((node) => node.cls.split(" ").includes("knap-server"));
			expect(lines()).toHaveLength(1);
			jest.advanceTimersByTime(5_000);
			expect(lines()).toHaveLength(1);
		} finally {
			jest.useRealTimers();
		}
	});

	it("writes a climbing count in place, leaving an opened fold open", () => {
		jest.useFakeTimers();
		try {
			const state: FakeState = {
				signedIn: true,
				linked: { id: "v1", name: "Work notes" },
				status: { word: SYNCING, dot: "working", vaultName: "Work notes", notes: 12 },
			};
			const { container } = drawWith(fakeSync(state));
			find(container, "knap-status-head")?.listeners.forEach((run) => run());
			expect(find(container, "knap-status-body")?.hidden).toBe(false);

			state.status = { ...state.status, notes: 141 };
			jest.advanceTimersByTime(1_000);

			expect(find(container, "knap-status-detail")?.text).toBe("Work notes · 141 notes");
			// A redraw here would shut the fold under somebody reading it.
			expect(find(container, "knap-status-body")?.hidden).toBe(false);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("the bar", () => {
	it("wears the word and the dot, with the vault and its size beside them", () => {
		const { container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: UP_TO_DATE, dot: "ok", vaultName: "Work notes", notes: 1202 },
		});
		expect(find(container, "knap-status-word")?.text).toBe("Up to date");
		expect(find(container, "knap-dot-ok")).toBeDefined();
		expect(find(container, "knap-status-detail")?.text).toBe("Work notes · 1,202 notes");
	});

	it("starts folded, and opens when the head is pressed", () => {
		const { container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: SYNCING, dot: "working", vaultName: "Work notes", notes: 3 },
		});
		const head = find(container, "knap-status-head");
		const body = find(container, "knap-status-body");

		expect(body?.hidden).toBe(true);
		expect(head?.getAttribute("aria-expanded")).toBe("false");

		head?.listeners.forEach((run) => run());

		expect(body?.hidden).toBe(false);
		expect(head?.getAttribute("aria-expanded")).toBe("true");
	});

	it("puts the head above the body, whatever order they were built in", () => {
		const { container } = drawFor({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
		});
		const block = find(container, "knap-status");
		expect(block?.children[0].cls).toContain("knap-status-head");
	});

	it("retries when the button under Problem is pressed", async () => {
		const sync = fakeSync({
			signedIn: true,
			linked: { id: "v1", name: "Work notes" },
			status: { word: PROBLEM, dot: "error", vaultName: "Work notes", problems: 3 },
		});
		const { container } = drawWith(sync);
		find(container, "knap-status-retry")?.listeners.forEach((run) => run());
		await Promise.resolve();
		expect(sync.retried).toEqual(["retry"]);
	});
});

describe("what the fold holds", () => {
	it("leaves out every fact it has nothing to say about", () => {
		expect(statusFacts({ ...baseStatus() } as never)).toEqual([]);
	});

	it("groups the note count the way the rest of the screen does", () => {
		expect(
			statusFacts({ ...baseStatus(), vaultName: "Work notes", notes: 1202 } as never),
		).toEqual([
			["Cloud vault", "Work notes"],
			["Notes", "1,202"],
		]);
	});

	it("counts one stuck change as a change, not as changes", () => {
		expect(statusFacts({ ...baseStatus(), problems: 1 } as never)).toEqual([
			["Could not sync", "1 change"],
		]);
	});

	it("offers the button only for the two words a person can act on", () => {
		expect(hasRetry({ ...baseStatus(), word: PROBLEM } as never)).toBe(true);
		expect(hasRetry({ ...baseStatus(), word: OFFLINE } as never)).toBe(true);
		expect(hasRetry({ ...baseStatus(), word: UP_TO_DATE } as never)).toBe(false);
		expect(hasRetry({ ...baseStatus(), word: SYNCING } as never)).toBe(false);
	});
});

describe("the sign-out notice", () => {
	it("says nothing was deleted when the server heard it", () => {
		expect(signOutNotice(true)).toContain("Nothing was deleted");
	});

	it("admits the token may still be live when it did not", () => {
		expect(signOutNotice(false)).toContain("may still count this device");
	});
});
