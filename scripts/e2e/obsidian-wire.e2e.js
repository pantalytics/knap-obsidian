/*
 * Driven inside a real Obsidian by run-obsidian-wire.sh, once per share
 * scope, in three phases, with the host acting as a second device between
 * them.
 *
 *   setup   make a relay backed share, whole vault or just Projects/, and a
 *           note with known bytes inside it
 *   push    connect, and let the plugin put those bytes into the CRDT
 *   land    open the note, so what the other device wrote reaches the disk
 *
 * The token store is stubbed, and that is the honest boundary. In the real
 * stack the control plane hands out a url and a signed token per document;
 * here it is a local url and an empty token. Everything below that is the
 * plugin's own: the read from disk, the provider, the url it builds, the
 * websocket, the sync protocol, the CRDT, and the write back to disk.
 *
 * One thing worth knowing before changing this. The share is created with a
 * relayId. Without one the plugin treats it as unlinked and the push path
 * bails out before it ever reads the file, which reads exactly like a broken
 * relay and is not.
 */
(async () => {
	const plugin = app.plugins.plugins["knap-sync"];
	if (!plugin) throw new Error("knap-sync is not loaded");
	const settle = (ms) => new Promise((r) => setTimeout(r, ms));
	// The note lives in Projects/ either way, so the same file is carried by a
	// vault share and by a folder share rooted at Projects. That is the point:
	// both modes have to move the same bytes.
	const vpath = "Projects/from-disk.md";
	const scope = "__SCOPE__";
	const sharePath = scope === "vault" ? "" : "Projects";
	const body = "# uit de vault\n\nDeze bytes stonden op schijf voordat er iets synchroniseerde.\n";

	// connect() registers the intent without always acting on it, so this
	// pokes the provider too and waits for the socket rather than for a delay.
	const bringUp = async (holder, budgetMs = 20000) => {
		const provider = holder._provider;
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline) {
			if (provider.wsconnected) return true;
			try {
				holder.connect();
			} catch (e) {
				/* the intent is enough */
			}
			try {
				provider.connect();
			} catch (e) {
				/* already connecting */
			}
			await settle(1500);
		}
		return provider.wsconnected;
	};

	if ("__PHASE__" === "setup") {
		const guidOf = (key) => {
			const found = String(key).match(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
			);
			return found ? found[found.length - 1] : null;
		};
		const token = (key) => ({
			token: "",
			url: "wss://localhost:__TLS_PORT__/doc/ws",
			docId: guidOf(key),
			expiryTime: Date.now() + 3600e3,
		});
		plugin.tokenStore.getTokenSync = (key) => token(key);
		plugin.tokenStore.getToken = async (key) => token(key);

		const shares = plugin.sharedFolders;
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

		if (!app.vault.getAbstractFileByPath("Projects")) {
			await app.vault.createFolder("Projects");
		}
		const existing = app.vault.getAbstractFileByPath(vpath);
		if (existing) await app.vault.delete(existing);
		await app.vault.create(vpath, body);

		// After the stub: a provider takes its token at construction.
		const share = shares.new(
			sharePath,
			"__FOLDER_GUID__",
			"relay-onprem",
			false,
			scope,
		);
		window.__knapShare = share;
		const docVPath = share.getVirtualPath(vpath);
		const docGuid =
			share.syncStore.get(docVPath) || share.syncStore.new(docVPath);
		return JSON.stringify({
			scope,
			sharePath,
			folderGuid: share.guid,
			docGuid,
			relayId: share.relayId,
			bytesOnDisk: (await app.vault.adapter.read(vpath)).length,
		});
	}

	if ("__PHASE__" === "push") {
		const share = window.__knapShare;
		await bringUp(share);
		for (let i = 0; i < 12 && !share.synced; i++) await settle(1000);
		const doc = share.getDoc(share.getVirtualPath(vpath), false);
		window.__knapDoc = doc;
		await bringUp(doc);
		await settle(1500);
		await plugin.backgroundSync.enqueueSync(doc);
		await settle(3000);
		return JSON.stringify({
			folderSynced: share.synced,
			docConnected: doc._provider.wsconnected,
			docUrl: doc._provider.url,
			inCrdt: doc.ytext.toString(),
			expected: body,
		});
	}

	if ("__PHASE__" === "land") {
		// What a person does, and the only thing that makes a remote change
		// reach the file: open the note. With no editor bound, nothing saves.
		const tfile = app.vault.getAbstractFileByPath(vpath);
		await app.workspace.getLeaf(true).openFile(tfile);
		await settle(5000);
		return JSON.stringify({
			inCrdt: window.__knapDoc.ytext.toString(),
			onDisk: await app.vault.adapter.read(vpath),
		});
	}

	throw new Error("unknown phase");
})();
