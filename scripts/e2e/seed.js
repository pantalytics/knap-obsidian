/*
 * Put the shapes the scope end to end needs into the harness vault.
 *
 * Two of these are edge cases rather than filler. `Projects/Deep.md` sits
 * beside the folder `Projects/Deep/`, which is the prefix boundary a share
 * must not cross by accident. `Projects/.hidden.md` is a dot path inside an
 * ordinary folder, which the config directory check alone would miss.
 */
(async () => {
	const mkdir = async (p) => {
		if (!app.vault.getAbstractFileByPath(p)) await app.vault.createFolder(p);
	};
	const write = async (p, c) => {
		if (!app.vault.getAbstractFileByPath(p)) await app.vault.create(p, c);
	};

	await mkdir("Projects");
	await mkdir("Projects/Deep");
	await mkdir("Areas");

	await write("top-level.md", "# top level");
	await write("Projects/a.md", "# a");
	await write("Projects/Deep.md", "# a file beside the folder of the same name");
	await write("Projects/Deep/b.md", "# nested");
	await write("Areas/c.md", "# another folder");

	// Adapter writes, because these are exactly the paths the vault index
	// does not carry.
	await app.vault.adapter.write("Projects/.hidden.md", "# a dot path");
	await app.vault.adapter
		.write(`${app.vault.configDir}/probe.json`, "{}")
		.catch(() => {});

	return JSON.stringify({
		notes: app.vault.getMarkdownFiles().length,
		configDir: app.vault.configDir,
	});
})();
