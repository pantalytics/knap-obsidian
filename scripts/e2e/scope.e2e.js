/*
 * End to end for the share scope model, run inside a real Obsidian.
 *
 * What it proves, against a live app and a real vault on disk:
 *   - a vault share takes every note, nested and top level alike
 *   - a vault share takes neither the config directory nor any dot path
 *   - a folder share takes its subtree and nothing else
 *   - the two modes refuse to coexist, in either order
 *   - an inbound write naming the config directory, a traversal or a dot
 *     path is refused, and an ordinary one still lands on disk
 *
 * What it does not prove: anything over the wire. There is no relay in this
 * loop, so this is the scope model end to end, not sync end to end. Run it
 * with scripts/e2e/run.sh, which is where the assertions live.
 */
(async () => {
	const plugin = app.plugins.plugins["knap-sync"];
	if (!plugin) throw new Error("knap-sync is not loaded");
	const shares = plugin.sharedFolders;

	const reset = async () => {
		shares
			.items()
			.slice()
			.forEach((f) => {
				try {
					shares.delete(f);
				} catch (e) {
					/* already gone */
				}
			});
		await plugin.folderSettings.set([]);
	};

	// The outbound membership decision, asked of every markdown file the
	// vault knows about.
	const members = (share) =>
		app.vault
			.getAllLoadedFiles()
			.filter((f) => f.extension === "md")
			.filter((f) => {
				try {
					return share.isSyncableTFile(f);
				} catch (e) {
					return false;
				}
			})
			.map((f) => f.path)
			.sort();

	const guid = (n) => `00000000-0000-4000-8000-0000000e${String(n).padStart(4, "0")}`;
	const out = {};

	// --- the whole vault ------------------------------------------------- //
	await reset();
	const vault = shares.new("", guid(1), undefined, false, "vault");
	const vaultMembers = members(vault);
	out.vault = {
		total: vaultMembers.length,
		hasTopLevel: vaultMembers.some((p) => !p.includes("/")),
		hasNested: vaultMembers.some((p) => p.split("/").length >= 3),
		leaksConfigDir: vaultMembers.some((p) => p.startsWith(app.vault.configDir)),
		leaksDotPath: vaultMembers.some((p) =>
			p.split("/").some((s) => s.startsWith(".")),
		),
	};

	// --- one folder ------------------------------------------------------ //
	await reset();
	const folder = shares.new("Projects", guid(2), undefined, false, "folder");
	const folderMembers = members(folder);
	out.folder = {
		total: folderMembers.length,
		onlySubtree: folderMembers.every((p) => p.startsWith("Projects/")),
		hasNested: folderMembers.some((p) => p.startsWith("Projects/Deep/")),
		leaksDotPath: folderMembers.some((p) =>
			p.split("/").some((s) => s.startsWith(".")),
		),
	};

	// --- the two modes are exclusive ------------------------------------- //
	const attempt = (path, n, scope) => {
		try {
			shares.new(path, guid(n), undefined, false, scope);
			return "allowed";
		} catch (e) {
			return "refused";
		}
	};
	await reset();
	shares.new("Projects", guid(3), undefined, false, "folder");
	out.folderThenVault = attempt("", 4, "vault");
	await reset();
	shares.new("", guid(5), undefined, false, "vault");
	out.vaultThenFolder = attempt("Projects", 6, "folder");

	// --- the inbound write guard ----------------------------------------- //
	await reset();
	const target = shares.new("", guid(7), undefined, false, "vault");
	const write = async (vpath) => {
		try {
			await target.flush({ path: vpath }, "e2e");
			return "wrote";
		} catch (e) {
			return "refused";
		}
	};
	const probe = "Projects/scope-e2e-probe.md";
	out.writeGuard = {
		configDir: await write(`${app.vault.configDir}/plugins/evil/main.js`),
		traversal: await write("../outside.md"),
		dotPath: await write(".secret.md"),
		ordinary: await write(probe),
	};

	// And the disk is the witness, not the return value.
	const adapter = app.vault.adapter;
	out.disk = {
		ordinaryLanded: await adapter.exists(probe),
		configDirUntouched: !(await adapter.exists(
			`${app.vault.configDir}/plugins/evil/main.js`,
		)),
		dotPathUntouched: !(await adapter.exists(".secret.md")),
	};
	if (out.disk.ordinaryLanded) await adapter.remove(probe);

	await reset();
	return JSON.stringify(out);
})();
