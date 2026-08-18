import * as Y from "yjs";
import {
	DEVICE_STAMP_INTERVAL_MS,
	KNAP_DEVICES_KEY,
	KNAP_META_KEY,
	forgetKnapDevice,
	readKnapDevices,
	readKnapMeta,
	stampKnapDevice,
	stampKnapMeta,
} from "../src/knapMeta";

describe("what a share says about itself", () => {
	test("a vault share says so, and says what the vault is called", () => {
		const doc = new Y.Doc();
		expect(stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" })).toBe(true);

		expect(readKnapMeta(doc)).toEqual({ scope: "vault", vault: "Pantalytics" });
	});

	test("a folder share says that instead", () => {
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "folder", vault: "Pantalytics" });

		expect(readKnapMeta(doc)?.scope).toBe("folder");
	});

	test("it lives in a map of its own and leaves the file lists alone", () => {
		// The document is upstream's and carries the folder's contents. Ours is
		// one key beside them, which is what makes it safe to write into a
		// structure we did not design.
		const doc = new Y.Doc();
		doc.getMap<string>("docs").set("Note.md", "doc-1");
		stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" });

		expect(doc.getMap<string>("docs").get("Note.md")).toBe("doc-1");
		expect(doc.getMap("filemeta_v0").size).toBe(0);
		expect(doc.getMap(KNAP_META_KEY).size).toBe(2);
	});

	test("writing the same thing twice is not a write", () => {
		// It runs on every connect rather than once at creation, because a share
		// made by an older build carries no key at all. Without this every
		// device would broadcast an update on every start.
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" });

		let updates = 0;
		doc.on("update", () => {
			updates += 1;
		});
		expect(stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" })).toBe(false);
		expect(updates).toBe(0);
	});

	test("a vault keeps the name it was given, whoever connects next", () => {
		// A vault is picked from a list now, so one vault on Knap can be open
		// in local vaults called different things. Writing the local name
		// through would hand the vault's name on Knap to whoever opened
		// Obsidian last.
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" });

		expect(stampKnapMeta(doc, { scope: "vault", vault: "Laptop copy" })).toBe(false);
		expect(readKnapMeta(doc)?.vault).toBe("Pantalytics");
	});

	test("a share that carries no name yet gets one", () => {
		// Every vault made before this key existed, and every vault the moment
		// after it is created. The first device to sync it names it.
		const doc = new Y.Doc();
		doc.getMap<string>(KNAP_META_KEY).set("scope", "vault");

		expect(stampKnapMeta(doc, { scope: "vault", vault: "Pantalytics" })).toBe(true);
		expect(readKnapMeta(doc)?.vault).toBe("Pantalytics");
	});

	test("the scope is corrected even though the name is not", () => {
		// The scope is not a name: both sides compute it the same way, and a
		// share whose shape changed under an older build carries a stale one.
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "folder", vault: "Pantalytics" });

		expect(stampKnapMeta(doc, { scope: "vault", vault: "Anything else" })).toBe(true);
		expect(readKnapMeta(doc)).toEqual({ scope: "vault", vault: "Pantalytics" });
	});

	test("surrounding whitespace never reaches the panel", () => {
		const doc = new Y.Doc();
		stampKnapMeta(doc, { scope: "vault", vault: "  Pantalytics  " });

		expect(readKnapMeta(doc)?.vault).toBe("Pantalytics");
	});

	test("a document nobody stamped answers nothing rather than guessing", () => {
		expect(readKnapMeta(new Y.Doc())).toBeNull();
	});
});


describe("which local vaults sync this cloud vault", () => {
	const laptop = {
		vault: "Pantalytics",
		platform: "desktop",
		version: "1.11.0",
		user: "user-rutger",
		seen: 1_000_000,
	};

	test("a device says what it is, in a map of its own", () => {
		const doc = new Y.Doc();

		expect(stampKnapDevice(doc, "app-1", laptop)).toBe(true);
		expect(readKnapDevices(doc)).toEqual({ "app-1": laptop });
		// Beside the vault's own key rather than inside it: one carries two
		// strings about the vault, the other a row per device.
		expect(doc.getMap(KNAP_META_KEY).size).toBe(0);
	});

	test("two devices are two rows, and neither overwrites the other", () => {
		// The whole reason this is keyed by device. The vault's name is a
		// single value and two devices disagreeing about it settle on
		// whichever wrote last; these may not.
		const doc = new Y.Doc();
		const phone = { ...laptop, vault: "Notes on iPhone", platform: "mobile" };

		stampKnapDevice(doc, "app-1", laptop);
		stampKnapDevice(doc, "app-2", phone);

		expect(readKnapDevices(doc)).toEqual({ "app-1": laptop, "app-2": phone });
	});

	test("a local vault called something else is the point, not a conflict", () => {
		// Since the picker, one cloud vault can be open in local vaults called
		// different things. That is what makes the row worth drawing.
		const doc = new Y.Doc();
		stampKnapDevice(doc, "app-1", laptop);
		stampKnapDevice(doc, "app-2", { ...laptop, vault: "Werk" });

		expect(Object.values(readKnapDevices(doc)).map((d) => d.vault).sort()).toEqual([
			"Pantalytics",
			"Werk",
		]);
	});

	test("reconnecting every minute is not an update every minute", () => {
		// It runs on every connect, and a flaky connection would otherwise be
		// a stream of updates every other device receives.
		const doc = new Y.Doc();
		stampKnapDevice(doc, "app-1", laptop);

		let updates = 0;
		doc.on("update", () => {
			updates += 1;
		});
		expect(stampKnapDevice(doc, "app-1", { ...laptop, seen: laptop.seen + 60_000 })).toBe(
			false,
		);
		expect(updates).toBe(0);
	});

	test("an hour later the row moves, so last seen means something", () => {
		const doc = new Y.Doc();
		stampKnapDevice(doc, "app-1", laptop);
		const later = { ...laptop, seen: laptop.seen + DEVICE_STAMP_INTERVAL_MS + 1 };

		expect(stampKnapDevice(doc, "app-1", later)).toBe(true);
		expect(readKnapDevices(doc)["app-1"].seen).toBe(later.seen);
	});

	test("a rename or an upgrade is written through at once", () => {
		// Neither waits for the hour: they are what the row says about itself,
		// and a stale one is what somebody would notice.
		const doc = new Y.Doc();
		stampKnapDevice(doc, "app-1", laptop);

		expect(stampKnapDevice(doc, "app-1", { ...laptop, vault: "Renamed" })).toBe(true);
		expect(stampKnapDevice(doc, "app-1", { ...laptop, vault: "Renamed", version: "1.12.0" })).toBe(
			true,
		);
	});

	test("two people's devices each say whose they are", () => {
		// What the row could not answer until now: a vault two people sync
		// listed four machines and no way to tell which two were yours. The
		// id and not the address -- everybody on the vault reads this, and
		// Knap resolves the id against the member list it already has.
		const doc = new Y.Doc();
		stampKnapDevice(doc, "app-1", laptop);
		stampKnapDevice(doc, "app-2", { ...laptop, user: "user-daniel" });

		expect(Object.values(readKnapDevices(doc)).map((d) => d.user).sort()).toEqual([
			"user-daniel",
			"user-rutger",
		]);
	});

	test("signing in on a device that was not is written through at once", () => {
		// Same rule as a rename: it is what the row says about itself, and an
		// hour of a laptop showing up as nobody's is an hour of the wrong page.
		const doc = new Y.Doc();
		stampKnapDevice(doc, "app-1", { ...laptop, user: "" });

		expect(stampKnapDevice(doc, "app-1", laptop)).toBe(true);
		expect(readKnapDevices(doc)["app-1"].user).toBe("user-rutger");
	});

	test("a row from a build before the field reads as nobody, not as broken", () => {
		const doc = new Y.Doc();
		doc.getMap<string>(KNAP_DEVICES_KEY).set(
			"app-1",
			JSON.stringify({ vault: "Pantalytics", platform: "desktop", version: "1.13.2", seen: 1 }),
		);

		expect(readKnapDevices(doc)["app-1"].user).toBe("");
	});

	test("leaving takes the row out", () => {
		const doc = new Y.Doc();
		stampKnapDevice(doc, "app-1", laptop);

		expect(forgetKnapDevice(doc, "app-1")).toBe(true);
		expect(readKnapDevices(doc)).toEqual({});
		expect(forgetKnapDevice(doc, "app-1")).toBe(false);
	});

	test("a device with no id writes nothing rather than a row nobody owns", () => {
		const doc = new Y.Doc();

		expect(stampKnapDevice(doc, "  ", laptop)).toBe(false);
		expect(readKnapDevices(doc)).toEqual({});
	});

	test("a row of the wrong shape is skipped rather than thrown over", () => {
		// The writer ships separately and updates on its own schedule, and
		// this runs inside a sync callback that must not throw.
		const doc = new Y.Doc();
		doc.getMap<string>(KNAP_DEVICES_KEY).set("app-1", "not json");
		doc.getMap<string>(KNAP_DEVICES_KEY).set("app-2", JSON.stringify(laptop));

		expect(readKnapDevices(doc)).toEqual({ "app-2": laptop });
	});

	test("a row missing half its fields answers with the half it has", () => {
		const doc = new Y.Doc();
		doc.getMap<string>(KNAP_DEVICES_KEY).set("app-1", JSON.stringify({ vault: "V" }));

		expect(readKnapDevices(doc)["app-1"]).toEqual({
			vault: "V",
			platform: "",
			version: "",
			user: "",
			seen: 0,
		});
	});
});
