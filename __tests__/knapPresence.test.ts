import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
	KNAP_AWARENESS_FIELD,
	owed,
	publishPresence,
	stateFor,
	withdrawPresence,
	type DevicePresence,
} from "../src/knapPresence";

function presence(over: Partial<DevicePresence> = {}): DevicePresence {
	return {
		state: "syncing",
		up: 12,
		down: 3,
		vault: "Pantalytics",
		platform: "desktop",
		...over,
	};
}

describe("what a device says it is doing right now", () => {
	test("it carries the install id, which is what joins it to its row", () => {
		// Upstream's own `user` field names the account and is the same on
		// every machine one person owns, so without this the live half could
		// only ever say somebody of mine is connected.
		const awareness = new Awareness(new Y.Doc());
		publishPresence(awareness, "app-1", presence());

		expect(awareness.getLocalState()?.[KNAP_AWARENESS_FIELD]).toEqual({
			install: "app-1",
			state: "syncing",
			up: 12,
			down: 3,
			vault: "Pantalytics",
			platform: "desktop",
		});
	});

	test("none of it enters the document", () => {
		// The whole reason the live half is awareness rather than a second
		// stamp in `knap_devices_v0`: this goes out every few seconds, and a
		// document that grew each time would be paid for by every device on
		// the vault, forever.
		const doc = new Y.Doc();
		publishPresence(new Awareness(doc), "app-1", presence());

		expect(doc.getMap("knap_devices_v0").size).toBe(0);
		expect(Y.encodeStateAsUpdate(doc).length).toBeLessThan(10);
	});

	test("a device with no id says nothing, rather than something unjoinable", () => {
		const awareness = new Awareness(new Y.Doc());
		publishPresence(awareness, "  ", presence());

		expect(awareness.getLocalState()?.[KNAP_AWARENESS_FIELD]).toBeUndefined();
	});

	test("a count that went wrong is clamped rather than published", () => {
		// It lands on somebody's own vault page. Two devices disagreeing about
		// arithmetic is a bug; a negative note count on a screen is a mystery.
		const awareness = new Awareness(new Y.Doc());
		publishPresence(awareness, "app-1", presence({ up: -4, down: 2.6 }));

		const said = awareness.getLocalState()?.[KNAP_AWARENESS_FIELD];
		expect(said.up).toBe(0);
		expect(said.down).toBe(3);
	});

	test("a device can stop claiming to be here", () => {
		const awareness = new Awareness(new Y.Doc());
		publishPresence(awareness, "app-1", presence());
		withdrawPresence(awareness);

		expect(awareness.getLocalState()?.[KNAP_AWARENESS_FIELD]).toBeNull();
	});
});

describe("which way a device is behind", () => {
	test("what is queued up is not the same as what is queued down", () => {
		// They ask different things of a person: notes waiting to go up need
		// this machine left open, notes waiting to come down need nothing.
		expect(
			owed({ syncs: 10, completedSyncs: 4, downloads: 3, completedDownloads: 3 }),
		).toEqual({ up: 6, down: 0 });
	});

	test("a folder with nothing queued owes nothing", () => {
		expect(owed(undefined)).toEqual({ up: 0, down: 0 });
		expect(
			owed({ syncs: 2, completedSyncs: 2, downloads: 1, completedDownloads: 1 }),
		).toEqual({ up: 0, down: 0 });
	});

	test("a group that counted past its own total does not go negative", () => {
		expect(
			owed({ syncs: 1, completedSyncs: 4, downloads: 0, completedDownloads: 0 }),
		).toEqual({ up: 0, down: 0 });
	});
});

describe("the word a device uses for itself", () => {
	test("nothing queued in either direction is up to date", () => {
		expect(stateFor({ signedIn: true, paused: false, up: 0, down: 0 })).toBe(
			"up_to_date",
		);
	});

	test("anything queued in either direction is syncing", () => {
		expect(stateFor({ signedIn: true, paused: false, up: 1, down: 0 })).toBe("syncing");
		expect(stateFor({ signedIn: true, paused: false, up: 0, down: 1 })).toBe("syncing");
	});

	test("signed out and paused are not states the counts can argue with", () => {
		expect(stateFor({ signedIn: false, paused: false, up: 9, down: 0 })).toBe(
			"signed_out",
		);
		expect(stateFor({ signedIn: true, paused: true, up: 9, down: 0 })).toBe("paused");
	});

	test("every word it can produce is one the panel has a name for", () => {
		// The list lives in status.py in the admin repository and is mirrored
		// in syncStatus.ts. A word invented here draws a dot with no rule
		// behind it, on a screen in another repository, with nothing failing.
		const words = new Set(["syncing", "up_to_date", "paused", "signed_out"]);
		for (const signedIn of [true, false]) {
			for (const paused of [true, false]) {
				for (const up of [0, 3]) {
					expect(words.has(stateFor({ signedIn, paused, up, down: 0 }))).toBe(true);
				}
			}
		}
	});
});
