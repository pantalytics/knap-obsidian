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
 * Persistence goes through two callbacks rather than a settings object, so
 * the host (Obsidian's data.json in production, a dict in tests) stays out
 * of the engine.
 */

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
}

export class KnapSync {
	readonly server: KnapServer;
	readonly flow: SignInFlow;
	private client: KnapVaultClient | null = null;
	private binding: VaultBinding | null = null;

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
		await this.binding.start();
	}

	stop(): void {
		this.binding?.stop();
		this.binding = null;
		this.client?.destroy();
		this.client = null;
	}
}
