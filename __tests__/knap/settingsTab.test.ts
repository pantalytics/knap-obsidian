/**
 * The screen has a button, and it says the right thing in each of the three
 * states it can be in.
 *
 * It exists because the commands were the only way in, and somebody asked to
 * try the beta opens Settings first. In a beta build the relay's own tab is
 * hidden, so they found nothing at all -- which reads as a plugin that does
 * not work rather than one whose entry point is in the command palette.
 */

import { KnapSettingsTab } from "../../src/knap/KnapSettingsTab";

type Row = { name: string; desc: string; buttons: string[]; press?: () => void };

/** A stand-in for Obsidian's Setting, recording what the screen asked for. */
function fakeContainer(rows: Row[]) {
	return {
		empty: () => rows.splice(0, rows.length),
		rows,
	};
}

jest.mock("obsidian", () => {
	const rows: Row[] = [];
	class Setting {
		private row: Row = { name: "", desc: "", buttons: [] };
		constructor(container: { rows?: Row[] }) {
			(container.rows ?? rows).push(this.row);
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

/** A stand-in KnapSync that remembers whether it was signed out. */
function fakeSync(state: { signedIn: boolean; linked: null | { id: string; name: string } }) {
	let signedIn = state.signedIn;
	let linked = state.linked;
	return {
		get signedIn() {
			return signedIn;
		},
		get linked() {
			return linked
				? { cloudVaultId: linked.id, cloudVaultName: linked.name, token: "t" }
				: null;
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

function tabWith(sync: ReturnType<typeof fakeSync>) {
	const rows: Row[] = [];
	const plugin = { app: {} };
	const actions = { signIn: async () => {}, pickAndLink: async () => {} };
	const tab = new KnapSettingsTab(
		plugin as never,
		sync as never,
		actions as never,
		"https://next.knap.test",
	);
	tab.containerEl = fakeContainer(rows) as never;
	tab.display();
	return rows;
}

function tabFor(state: { signedIn: boolean; linked: null | { id: string; name: string } }) {
	return tabWith(fakeSync(state));
}

describe("the beta's settings screen", () => {
	it("offers signing in, and names the server this build talks to", () => {
		const rows = tabFor({ signedIn: false, linked: null });
		expect(rows.flatMap((r) => r.buttons)).toContain("Sign in");
		expect(rows.map((r) => r.desc).join(" ")).toContain("https://next.knap.test");
		// Nothing to unlink from when nobody is signed in.
		expect(rows.flatMap((r) => r.buttons)).not.toContain("Unlink");
	});

	it("offers linking once signed in, and does not offer unlink yet", () => {
		const rows = tabFor({ signedIn: true, linked: null });
		expect(rows.flatMap((r) => r.buttons)).toContain("Link a cloud vault");
		expect(rows.flatMap((r) => r.buttons)).not.toContain("Unlink");
		expect(rows.map((r) => r.desc).join(" ")).toContain("not linked");
	});

	it("names the linked vault, and offers unlink beside it", () => {
		const rows = tabFor({ signedIn: true, linked: { id: "v1", name: "Pantalytics_v03" } });
		expect(rows.map((r) => r.desc).join(" ")).toContain("Pantalytics_v03");
		// A person deleting a note is entitled to know it goes on both sides.
		expect(rows.map((r) => r.desc).join(" ")).toContain("delete here");
		expect(rows.flatMap((r) => r.buttons)).toContain("Unlink");
		expect(rows.map((r) => r.desc).join(" ")).toContain("Nothing is deleted");
	});

	it("offers a way back out in both signed-in states", () => {
		// The screen had no way out at all: the only way to stop being signed
		// in on a device was to uninstall the plugin, which leaves the token
		// alive anyway.
		for (const linked of [null, { id: "v1", name: "Pantalytics_v03" }]) {
			const rows = tabFor({ signedIn: true, linked });
			expect(rows.flatMap((r) => r.buttons)).toContain("Sign out");
			// Unlink stops the syncing; sign out is the account, and says so.
			const out = rows.find((r) => r.name === "Sign out");
			expect(out?.desc).toContain("this device");
			expect(out?.desc).toContain("Your notes stay");
		}
	});

	it("signs out when the button is pressed, and comes back offering sign in", async () => {
		const sync = fakeSync({ signedIn: true, linked: { id: "v1", name: "Pantalytics_v03" } });
		const rows = tabWith(sync);

		rows.find((r) => r.name === "Sign out")?.press?.();
		await Promise.resolve();
		await Promise.resolve();

		// The same rows array, redrawn: nothing about the account is left.
		expect(rows.flatMap((r) => r.buttons)).toEqual(["Sign in"]);
		expect(rows.map((r) => r.desc).join(" ")).not.toContain("Pantalytics_v03");
	});
});
