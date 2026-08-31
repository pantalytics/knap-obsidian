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
 * Persistence goes through two callbacks rather than a settings object, so
 * the host (Obsidian's data.json in production, a dict in tests) stays out
 * of the engine.
 */

import type { AttachmentTransport, Refusal } from "./AttachmentBinding";
import { AttachmentBinding } from "./AttachmentBinding";
import type { FileStore } from "./VaultBinding";
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
		this.binding = new VaultBinding(this.options.files, this.client);
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

	stop(): void {
		this.attachments?.stop();
		this.attachments = null;
		this.binding?.stop();
		this.binding = null;
		this.client?.destroy();
		this.client = null;
	}
}
