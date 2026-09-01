/**
 * The orchestrator: sign-in, the link, and the running binding, as state.
 *
 * A local vault is linked to at most one cloud vault, linking replaces
 * rather than appends, and Unlink ends the link without deleting anything
 * on either side (ADR-0066, ADR-0047). This class is that sentence as
 * code: `link` tears down whatever ran before it starts the new binding,
 * and `unlink` stops the sockets and clears the remembered vault while the
 * sign-in survives, because the account and the link are different facts.
 *
 * `signOut` is the other direction of the same distinction: the account
 * goes, and the link goes with it, because a link is to a cloud vault of
 * the account that is leaving. Holding one without a token would be a
 * settings row that says this vault syncs with something it can no longer
 * reach, and that is how a device ends up showing somebody else's folders.
 *
 * Unlink and sign out also throw away what this device remembered of the
 * cloud vault's tree. Both say on screen that nothing is deleted anywhere,
 * and a kept record would make a later relink start by deleting whatever
 * was removed here in between. No memory means no deletions, which is what
 * linking has always done.
 *
 * Persistence goes through two callbacks rather than a settings object, so
 * the host (Obsidian's data.json in production, a dict in tests) stays out
 * of the engine.
 */

import type { SyncDot, SyncWord } from "../syncStatus";
import { syncDot, syncWord } from "../syncStatus";
import type { AttachmentTransport, Refusal } from "./AttachmentBinding";
import { AttachmentBinding } from "./AttachmentBinding";
import type { LiveNoteHandle } from "./knapEditor";
import { normalize } from "./TreeDoc";
import type { FileStore, SeenTree } from "./VaultBinding";
import { VaultBinding } from "./VaultBinding";
import type { CloudVault, Fetch } from "./KnapServer";
import { KnapServer } from "./KnapServer";
import { KnapVaultClient } from "./KnapVaultClient";
import type { WebSocketImpl } from "./KnapVaultClient";
import { SignInFlow } from "./SignInFlow";

export interface KnapLink {
	token: string;
	cloudVaultId: string;
	cloudVaultName: string;
}

/**
 * Everything the status bar reads, in one call.
 *
 * One reading rather than five getters, because the screen and the mark in
 * the corner of the window must never disagree, and two callers asking four
 * questions each is how they start to. Whatever it says was true at one
 * instant.
 */
export interface KnapStatus {
	word: SyncWord;
	dot: SyncDot;
	/** The cloud vault this local one is linked to, or "" when it is not. */
	vaultName: string;
	/** Notes the tree holds. Zero until the tree has been read. */
	notes: number;
	/** Pieces of work that failed and stayed failed. */
	problems: number;
}

export interface KnapSyncOptions {
	serverUrl: string;
	deviceName: string;
	fetchFn: Fetch;
	files: FileStore;
	load: () => KnapLink | null;
	save: (value: KnapLink | null) => Promise<void>;
	/** Injected in tests; Obsidian's platform WebSocket by default. */
	webSocket?: WebSocketImpl;
	/**
	 * Told when an attachment cannot travel, so the host can put it on
	 * screen. A file over the ceiling is the common case, and somebody who
	 * is never told will find out when the photo is missing on their phone.
	 */
	onRefused?: Refusal;
	/** Where this device remembers a cloud vault's tree, if anywhere. */
	makeSeen?: (cloudVaultId: string) => SeenTree;
}

export class KnapSync {
	readonly server: KnapServer;
	readonly flow: SignInFlow;
	private client: KnapVaultClient | null = null;
	private binding: VaultBinding | null = null;
	private attachments: AttachmentBinding | null = null;

	constructor(private readonly options: KnapSyncOptions) {
		this.server = new KnapServer(options.serverUrl, options.fetchFn);
		this.flow = new SignInFlow(this.server, options.deviceName);
	}

	get linked(): KnapLink | null {
		const stored = this.options.load();
		return stored && stored.cloudVaultId ? stored : null;
	}

	get signedIn(): boolean {
		return Boolean(this.options.load()?.token);
	}

	get running(): boolean {
		return this.binding !== null;
	}

	/**
	 * What to put on the screen and in the corner of the window.
	 *
	 * Nothing here decides for itself whether things are healthy. It reads
	 * the token, the link, the socket and the queue's failure count, and
	 * hands them to `syncWord`, which owns the order those facts win in.
	 *
	 * A vault with no link is Paused rather than Up to date: nothing is
	 * moving, nothing is going to, and green over it would say the notes
	 * were safe somewhere they have never been.
	 *
	 * Syncing is "linked, connected, and the tree has not settled yet". Once
	 * the tree has been through its first exchange there is nothing this side
	 * is waiting for, and a spinner that never stops is worse than no spinner.
	 */
	status(): KnapStatus {
		const linked = this.linked;
		const connected = this.client?.connected ?? false;
		const problems = this.binding?.problems ?? 0;
		const word = syncWord({
			signedIn: this.signedIn,
			// Signed in with nowhere to sync to is not up to date, it is
			// standing still: nothing is moving and nothing is going to
			// until somebody picks a cloud vault. Green over that vault is
			// the same lie #40 was about, and #42 already settled the word
			// for a vault waiting to be told which cloud vault it belongs
			// to. The screen says Not linked in full; the corner of the
			// window has one word to do it in.
			paused: !linked,
			syncing: Boolean(this.client) && !this.client?.settled,
			// Not linked is not offline: there is no socket because there is
			// nothing to open one to, and saying Offline would send somebody
			// to check their wifi over a vault they never linked.
			connected: linked ? connected : undefined,
			stuck: problems,
		});
		return {
			word,
			dot: syncDot(word),
			vaultName: linked?.cloudVaultName ?? "",
			notes: this.client ? this.client.tree().entries().size : 0,
			problems,
		};
	}

	/** Sign in: browser out, deep link back, token kept. No link yet. */
	async signIn(openUrl: (url: string) => void): Promise<void> {
		const token = await this.flow.begin(openUrl);
		const previous = this.options.load();
		await this.options.save({
			token,
			cloudVaultId: previous?.cloudVaultId ?? "",
			cloudVaultName: previous?.cloudVaultName ?? "",
		});
	}

	handleDeepLink(params: Record<string, string>): boolean {
		return this.flow.handleDeepLink(params);
	}

	async listVaults(): Promise<CloudVault[]> {
		const stored = this.options.load();
		if (!stored?.token) {
			throw new Error("Sign in first.");
		}
		return this.server.listVaults(stored.token);
	}

	/** Link this local vault to one cloud vault. Replaces, never appends. */
	async link(vault: CloudVault): Promise<void> {
		const stored = this.options.load();
		if (!stored?.token) {
			throw new Error("Sign in first.");
		}
		this.stop();
		await this.options.save({
			token: stored.token,
			cloudVaultId: vault.id,
			cloudVaultName: vault.name,
		});
		await this.start();
	}

	/** End the link. Stops the syncing, deletes nothing on either side. */
	async unlink(): Promise<void> {
		this.stop();
		await this.forgetSeen();
		const stored = this.options.load();
		if (stored) {
			await this.options.save({ ...stored, cloudVaultId: "", cloudVaultName: "" });
		}
	}

	/**
	 * End the sign-in on this device: sockets down, token handed back, and
	 * everything this vault remembered about the account forgotten.
	 *
	 * The local half always happens, network or no network. Somebody
	 * pressing this on a train is signing out, and a plugin that refused
	 * because it could not reach anything would leave them signed in with
	 * an error on screen. `endedRemotely` says which of the two it was, so
	 * the screen can be honest about a token that may still be live.
	 */
	async signOut(): Promise<{ endedRemotely: boolean }> {
		this.stop();
		this.flow.cancel(new Error("Signed out before this sign-in finished."));
		await this.forgetSeen();
		const stored = this.options.load();
		let endedRemotely = true;
		if (stored?.token) {
			try {
				await this.server.signOut(stored.token);
			} catch {
				// Swallowed on purpose: whatever went wrong out there does
				// not change what happens here, and the only thing the
				// screen needs from it is that it did not land.
				endedRemotely = false;
			}
		}
		await this.options.save(null);
		return { endedRemotely };
	}

	/** Bring the link up, if there is one. Safe to call at plugin load. */
	async start(): Promise<void> {
		const stored = this.linked;
		if (!stored || this.binding) {
			return;
		}
		this.client = new KnapVaultClient(
			this.server,
			stored.cloudVaultId,
			stored.token,
			this.options.deviceName,
			this.options.webSocket,
		);
		this.binding = new VaultBinding(
			this.options.files,
			this.client,
			undefined,
			this.options.makeSeen?.(stored.cloudVaultId) ?? null,
		);
		this.attachments = new AttachmentBinding(
			this.options.files,
			this.client,
			this.transportFor(stored.token, stored.cloudVaultId),
			this.options.onRefused,
		);
		// Notes first. Both wait for the same tree to sync, and a vault whose
		// notes are already arriving is the one somebody is looking at.
		await this.binding.start();
		await this.attachments.start();
	}

	/** The file routes, bound to one vault and one token. */
	private transportFor(token: string, vaultId: string): AttachmentTransport {
		const server = this.server;
		return {
			upload: (path, content) => server.uploadFile(token, vaultId, path, content),
			download: (path) => server.downloadFile(token, vaultId, path),
			remove: (path) => server.deleteFile(token, vaultId, path),
			limits: () => server.limits(token),
		};
	}

	/**
	 * The live note behind one vault path, for an editor to bind to.
	 *
	 * Null in every case where binding would be a guess: no link, a note the
	 * cloud vault has never heard of, or a socket that has not finished its
	 * first sync. That last one matters more than it looks. A document that
	 * is still syncing is empty, and an editor bound to an empty document
	 * reads it as a note nobody has typed in and offers the file's text to
	 * fill it, so the note would arrive a moment later and be merged with a
	 * copy of itself. The editor asks again on its next update, and by then
	 * the answer is a real document.
	 *
	 * Pinning is what keeps the note out of the socket pool for as long as
	 * the editor has it. A note that is already open in the pool, which is
	 * what a note somebody opens during a fill usually is, is promoted where
	 * it stands: same document, same socket, same sync, nothing repeated.
	 */
	openNote(path: string): LiveNoteHandle | null {
		const clean = normalize(path);
		if (!this.client || !this.binding) return null;
		const docId = this.client.tree().docIdFor(clean);
		if (!docId) return null;
		const note = this.client.pin(docId);
		if (!note.provider.synced) {
			// Handed straight back, so a note the editor did not take is a
			// note the pool may still close.
			note.release();
			return null;
		}
		const unhold = this.binding.hold(clean);
		return {
			text: note.text,
			awareness: note.provider.awareness,
			deviceName: this.options.deviceName,
			// The file is caught up from the document first, and only then
			// does the note go back into the pool, where it stays open until
			// the pool needs the socket for something else.
			release: () => {
				unhold();
				note.release();
			},
		};
	}

	/**
	 * Forget the tree this device remembered. Never fatal: the caller is
	 * unlinking or signing out, and a record that outlives it costs a relink
	 * that deletes nothing, which is the same thing the record not existing
	 * would have done.
	 */
	private async forgetSeen(): Promise<void> {
		const id = this.options.load()?.cloudVaultId;
		if (!id || !this.options.makeSeen) return;
		try {
			await this.options.makeSeen(id).forget();
		} catch {
			// Nothing to say and nothing to do: see above.
		}
	}

	/**
	 * Take the link down and bring it straight back up.
	 *
	 * What the button under Problem and Offline does. The failure count lives
	 * on the binding, so a fresh binding starts at zero, which is the honest
	 * reading: the word goes back to whatever is true after the retry rather
	 * than staying red on the strength of what already happened.
	 */
	async retry(): Promise<void> {
		this.stop();
		await this.start();
	}

	stop(): void {
		this.attachments?.stop();
		this.attachments = null;
		this.binding?.stop();
		this.binding = null;
		this.client?.destroy();
		this.client = null;
	}
}
