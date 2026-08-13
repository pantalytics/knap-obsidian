import {
	recallVault,
	rememberedVaultId,
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
