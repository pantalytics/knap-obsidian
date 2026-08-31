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
	const plugin = app.plugins.plugins["synced-vaults"];
	if (!plugin) throw new Error("synced-vaults is not loaded");
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
	//
	// The budget is what it is because each phase below is one
	// `Runtime.evaluate` over the harness's devtools socket, and that socket
	// gives up after thirty seconds (`cdp.py` in the admin repository). The
	// waits in a phase have to add up to less than that, or a connection that
	// never comes back reads as a timeout with nothing in it rather than as
	// the assertion it is: this phase used to budget 20s twice and a further
	// 12s, and a red run said only `TimeoutError`. Polling is quick and the
	// poke is not, because connect() on a provider that is already dialling
	// is noise.
	const bringUp = async (holder, budgetMs = 8000) => {
		const provider = holder._provider;
		const deadline = Date.now() + budgetMs;
		let poked = 0;
		while (Date.now() < deadline) {
			if (provider.wsconnected) return true;
			if (Date.now() - poked >= 1500) {
				poked = Date.now();
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
			}
			await settle(250);
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
		const started = Date.now();
		const share = window.__knapShare;
		await bringUp(share, 10000);
		const msShare = Date.now() - started;
		for (let i = 0; i < 16 && !share.synced; i++) await settle(250);
		const doc = share.getDoc(share.getVirtualPath(vpath), false);
		window.__knapDoc = doc;
		// Taken here, and not off the provider at the end. The document's
		// socket is the plugin's to hold and to let go of: the background sync
		// releases it once the document is synced, so a flag read three
		// seconds later says whether the plugin has finished, not whether it
		// ever connected. Measured: `shouldConnect` is already false by the
		// time enqueueSync returns, with the file's bytes in the CRDT.
		const docConnected = await bringUp(doc, 10000);
		const msDoc = Date.now() - started;
		await settle(500);
		await plugin.backgroundSync.enqueueSync(doc);
		// Poll for the bytes rather than sleeping through the worst case: the
		// waits are what push a phase past the devtools socket's patience, and
		// a first sync is usually done well inside a second.
		for (let i = 0; i < 16 && doc.ytext.toString() !== body; i++) await settle(250);
		return JSON.stringify({
			folderSynced: share.synced,
			docConnected,
			docUrl: doc._provider.url,
			inCrdt: doc.ytext.toString(),
			expected: body,
			// How long each half took, because a red run that says only
			// "never held an open socket" cannot tell slow from broken.
			msShare,
			msDoc,
			msTotal: Date.now() - started,
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
