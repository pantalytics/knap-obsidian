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
import { withTimeout } from "./withTimeout";

/**
 * How long a link waits for the cloud vault to answer before it says so.
 *
 * The same half minute the binding gives the tree, because it is the same
 * exchange being waited for from one step further out.
 */
const LINK_TIMEOUT_MS = 30_000;

/**
 * What a link says when the cloud vault never answered.
 *
 * It does not promise a retry, because nothing here schedules one: the link
 * is kept, the bar goes to Offline, and Try again is the thing to press.
 */
export const UNREACHABLE = "Could not reach the cloud vault. Your notes are safe here.";

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
	/** The cloud vault a link is being made to right now, if there is one. */
	private linkingTo: CloudVault | null = null;
	/** That link, so a second press is the same act rather than a new one. */
	private linkRun: Promise<void> | null = null;
	/** The first pass over the vault, while it is still running. */
	private filling: Promise<void> | null = null;
	private watchers = new Set<() => void>();

	constructor(private readonly options: KnapSyncOptions) {
		this.server = new KnapServer(options.serverUrl, options.fetchFn);
		this.flow = new SignInFlow(this.server, options.deviceName);
	}

	get linked(): KnapLink | null {
		const stored = this.options.load();
		return stored && stored.cloudVaultId ? stored : null;
	}

	/**
	 * The cloud vault this one is being linked to right now, or "".
	 *
	 * A state of its own on the screen, because it is one underneath: the
	 * vault is chosen, the socket is on its way up, and neither Choose nor
	 * Unlink is a thing to press yet.
	 */
	get linking(): string {
		return this.linkingTo?.name ?? "";
	}

	/**
	 * Told whenever what this object would answer has changed.
	 *
	 * The screen used to redraw only where it had just pressed something,
	 * so everything that finishes on its own -- a link coming up, a first
	 * pass ending -- happened behind a page that went on saying what was
	 * true when it was drawn. Returns the way to stop listening.
	 */
	onChange(watcher: () => void): () => void {
		this.watchers.add(watcher);
		return () => {
			this.watchers.delete(watcher);
		};
	}

	private announce(): void {
		for (const watcher of [...this.watchers]) {
			watcher();
		}
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
		const linking = this.linkingTo !== null;
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
			//
			// A vault being linked right now is the exception, and it has to
			// be, because Paused beats every word under it: the socket is on
			// its way up, which is the one moment where nothing is linked and
			// something is very much happening.
			paused: !linked && !linking,
			// The first pass counts as syncing while it runs. Notes are still
			// arriving all through it, and a bar that said Up to date over a
			// vault that is a third full is what made somebody press the
			// button a second time.
			syncing: linking || this.filling !== null || (this.client !== null && !this.client.settled),
			// Not linked is not offline: there is no socket because there is
			// nothing to open one to, and saying Offline would send somebody
			// to check their wifi over a vault they never linked. Neither is a
			// link being made: that socket is on its way up.
			connected: linked && !linking ? connected : undefined,
			stuck: problems,
		});
		return {
			word,
			dot: syncDot(word),
			vaultName: this.linkingTo?.name ?? linked?.cloudVaultName ?? "",
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
		this.announce();
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

	/**
	 * Link this local vault to one cloud vault. Replaces, never appends.
	 *
	 * Settles when the cloud vault answers, which is when the link exists.
	 * The first pass over the notes runs on behind it and reports itself on
	 * the bar. It used to settle only once every note had travelled, which on
	 * a phone is minutes of a screen still saying Not linked, and the second
	 * press that follows tore the first attempt down half way and reached the
	 * person as *This vault is not linked any more.* over a link they had
	 * just asked for (2026-09-01, on a phone, twice in one screenshot).
	 *
	 * Which is also why a link in flight is not restarted by a second press
	 * for the same vault: it is the same act, so it is the same promise.
	 */
	async link(vault: CloudVault): Promise<void> {
		const stored = this.options.load();
		if (!stored?.token) {
			throw new Error("Sign in first.");
		}
		if (this.linkRun) {
			if (this.linkingTo?.id === vault.id) {
				return this.linkRun;
			}
			throw new Error(`Still linking to ${this.linking}. Wait for that to finish.`);
		}
		this.linkingTo = vault;
		this.linkRun = this.relink(vault, stored.token);
		this.announce();
		try {
			await this.linkRun;
		} finally {
			this.linkingTo = null;
			this.linkRun = null;
			this.announce();
		}
	}

	/** The link itself: whatever ran before goes down, the new one comes up. */
	private async relink(vault: CloudVault, token: string): Promise<void> {
		this.stop();
		await this.options.save({
			token,
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
		this.announce();
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
		this.announce();
		return { endedRemotely };
	}

	/**
	 * Bring the link up, if there is one. Safe to call at plugin load.
	 *
	 * Returns once the cloud vault has answered, not once the vault is full.
	 * The first pass runs behind this call: it is minutes of work on a phone
	 * with a few thousand notes, none of it a question of whether the link
	 * exists, and what it finds is counted on the binding and reaches the
	 * screen as Syncing, then as Problem if something stayed stuck.
	 */
	async start(): Promise<void> {
		const stored = this.linked;
		if (!stored || this.binding) {
			return;
		}
		const client = new KnapVaultClient(
			this.server,
			stored.cloudVaultId,
			stored.token,
			this.options.deviceName,
			this.options.webSocket,
		);
		const binding = new VaultBinding(
			this.options.files,
			client,
			undefined,
			this.options.makeSeen?.(stored.cloudVaultId) ?? null,
		);
		const attachments = new AttachmentBinding(
			this.options.files,
			client,
			this.transportFor(stored.token, stored.cloudVaultId),
			this.options.onRefused,
		);
		this.client = client;
		this.binding = binding;
		this.attachments = attachments;
		// Notes first. Both wait for the same tree to sync, and a vault whose
		// notes are already arriving is the one somebody is looking at.
		//
		// Swallowed here and counted there: every unit the pass runs goes
		// through the binding's queue, which counts what fails, and a
		// rejection nobody is holding is an unhandled one in the console.
		this.filling = binding
			.start()
			.then(() => attachments.start())
			.catch(() => undefined)
			.finally(() => {
				if (this.binding === binding) {
					this.filling = null;
				}
				this.announce();
			});
		await withTimeout(client.treeSynced(), LINK_TIMEOUT_MS, UNREACHABLE);
		this.announce();
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
		// Whatever the first pass was still doing belongs to a client that no
		// longer exists, and its failures went down with the binding that was
		// counting them.
		this.filling = null;
		this.announce();
	}
}
