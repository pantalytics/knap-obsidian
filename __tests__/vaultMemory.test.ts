import {
	linkBelongsHere,
	recallVault,
	rememberedVaultId,
	storedLink,
	type MountedShare,
	type RememberedVault,
} from "../src/vaultMemory";

const vaultShare = (guid: string): MountedShare => ({ guid, isVaultScope: true });
const folderShare = (guid: string): MountedShare => ({ guid, isVaultScope: false });

describe("the remembered id", () => {
	test("is the id somebody picked", () => {
		expect(rememberedVaultId({ id: "abc" })).toBe("abc");
	});

	test("is nothing on an install that has never picked one", () => {
		// What NamespacedSettings hands back for a key nothing has written.
		expect(rememberedVaultId({})).toBeUndefined();
		expect(rememberedVaultId(undefined)).toBeUndefined();
	});

	test("is nothing when the record is there but empty", () => {
		expect(rememberedVaultId({ id: "" })).toBeUndefined();
	});
});

describe("reconciling the memory with what is mounted", () => {
	test("puts a remembered vault back when nothing is mounted", () => {
		// #64: the plugin was updated, the share record did not come back, and
		// the person is not asked again.
		const remembered: RememberedVault = {
			id: "cloud-1",
			name: "Second Brain",
			serverId: "knap",
			localId: "local-1",
		};

		// The whole record comes back, so the remount knows which server to
		// point at and the pair of ids stays a pair.
		expect(recallVault(remembered, [])).toEqual({
			action: "mount",
			vault: {
				id: "cloud-1",
				name: "Second Brain",
				serverId: "knap",
				localId: "local-1",
			},
		});
	});

	test("does nothing when the mounted vault is the remembered one", () => {
		expect(recallVault({ id: "cloud-1" }, [vaultShare("cloud-1")])).toEqual({
			action: "nothing",
		});
	});

	test("writes down a vault that was picked before there was anywhere to write it", () => {
		// Every install that chose its vault in an earlier release. The memory
		// fills itself in on the next load rather than waiting for a re-pick.
		expect(recallVault({}, [vaultShare("cloud-1")])).toEqual({
			action: "remember",
			id: "cloud-1",
		});
	});

	test("what is mounted wins when the two disagree", () => {
		// A mounted share is a share that is syncing. Nothing here tears one
		// down to match a note somebody's settings file kept.
		expect(recallVault({ id: "cloud-old" }, [vaultShare("cloud-new")])).toEqual({
			action: "remember",
			id: "cloud-new",
		});
	});

	test("does nothing on an install that never picked a vault", () => {
		expect(recallVault({}, [])).toEqual({ action: "nothing" });
		expect(recallVault(undefined, [])).toEqual({ action: "nothing" });
	});

	test("leaves folder shares alone", () => {
		// A vault share cannot sit beside folder shares, so mounting one here
		// would throw. The screen that offers to take the folders off owns it.
		expect(recallVault({ id: "cloud-1" }, [folderShare("f1")])).toEqual({
			action: "nothing",
		});
	});
});

describe("whether a link belongs to this local vault", () => {
	test("it does when the ids match", () => {
		expect(linkBelongsHere({ id: "cloud-1", localId: "local-1" }, "local-1")).toBe(
			true,
		);
	});

	test("it does not when they do not", () => {
		// #71: one account, two local vaults, and the settings of one naming the
		// cloud vault of the other.
		expect(linkBelongsHere({ id: "cloud-1", localId: "local-1" }, "local-2")).toBe(
			false,
		);
	});

	test("a record that cannot say where it came from is treated as this vault's", () => {
		// NamespacedSettings hands back partial records. Refusing on a missing
		// field would ask the one question this file exists to stop asking.
		expect(linkBelongsHere({ id: "cloud-1" }, "local-1")).toBe(true);
		expect(linkBelongsHere({ id: "cloud-1", localId: "" }, "local-1")).toBe(true);
		expect(linkBelongsHere(undefined, "local-1")).toBe(true);
	});

	test("and so is one read where the app cannot say either", () => {
		expect(linkBelongsHere({ id: "cloud-1", localId: "local-1" }, undefined)).toBe(
			true,
		);
		expect(linkBelongsHere({ id: "cloud-1", localId: "local-1" }, "")).toBe(true);
	});
});

describe("a link belonging to another local vault", () => {
	const elsewhere: RememberedVault = {
		id: "cloud-1",
		name: "Somebody else's vault",
		serverId: "knap",
		localId: "local-1",
	};

	test("is dropped rather than mounted", () => {
		// The whole of #71. Mounting this is how one local vault ends up syncing
		// another's cloud vault.
		expect(recallVault(elsewhere, [], "local-2")).toEqual({ action: "forget" });
	});

	test("is still dropped when folder shares are mounted", () => {
		expect(recallVault(elsewhere, [folderShare("f1")], "local-2")).toEqual({
			action: "forget",
		});
	});

	test("loses to a mounted vault share, which rewrites it", () => {
		// What is mounted wins stays true: nothing here tears down a share that
		// is syncing, it corrects the record instead.
		expect(recallVault(elsewhere, [vaultShare("cloud-9")], "local-2")).toEqual({
			action: "remember",
			id: "cloud-9",
		});
	});

	test("is mounted as before when it does belong here", () => {
		expect(recallVault(elsewhere, [], "local-1")).toEqual({
			action: "mount",
			vault: {
				id: "cloud-1",
				name: "Somebody else's vault",
				serverId: "knap",
				localId: "local-1",
			},
		});
	});

	test("and the mounted-and-remembered pair is only agreement when it belongs here", () => {
		expect(recallVault(elsewhere, [vaultShare("cloud-1")], "local-1")).toEqual({
			action: "nothing",
		});
		// Same ids, wrong local vault: the record is rewritten to say so.
		expect(recallVault(elsewhere, [vaultShare("cloud-1")], "local-2")).toEqual({
			action: "remember",
			id: "cloud-1",
		});
	});
});

describe("reading the link off the stored rows", () => {
	test("one row at the vault root is the link", () => {
		expect(storedLink([{ guid: "cloud-1", path: "", scope: "vault" }])).toEqual({
			link: "one",
			guid: "cloud-1",
		});
	});

	test("a row written before the scope field is read off its path", () => {
		// Nothing wrote `scope` up to 1.12.3, so every install has these.
		expect(storedLink([{ guid: "cloud-1", path: "" }])).toEqual({
			link: "one",
			guid: "cloud-1",
		});
	});

	test("folder shares are not a link", () => {
		expect(
			storedLink([
				{ guid: "f1", path: "Projects" },
				{ guid: "f2", path: "Archive", scope: "folder" },
			]),
		).toEqual({ link: "none" });
	});

	test("nothing stored is no link", () => {
		expect(storedLink([])).toEqual({ link: "none" });
	});

	test("more than one row at the root is a conflict, not a choice", () => {
		// #71 on disk: three rows at `path: ""`, and which one won was decided
		// by array order. Every one of them reads as vault scope.
		expect(
			storedLink([
				{ guid: "cloud-gone", path: "", scope: "vault" },
				{ guid: "cloud-mine", path: "" },
				{ guid: "cloud-theirs", path: "" },
			]),
		).toEqual({
			link: "conflict",
			guids: ["cloud-gone", "cloud-mine", "cloud-theirs"],
		});
	});

	test("a folder share beside a conflict does not join it", () => {
		expect(
			storedLink([
				{ guid: "cloud-1", path: "" },
				{ guid: "f1", path: "Projects" },
				{ guid: "cloud-2", path: "" },
			]),
		).toEqual({ link: "conflict", guids: ["cloud-1", "cloud-2"] });
	});
});
