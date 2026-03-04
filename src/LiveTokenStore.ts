// This file is the Obsidian Live variant of the token store.
import { TokenStore } from "./TokenStore";
import type { TokenInfo } from "./TokenStore";
import type { TimeProvider } from "./TimeProvider";
import { LoginManager } from "./LoginManager";
import { curryLog } from "./debug";
import type { ClientToken, FileToken } from "./client/types";
import { LocalStorage } from "./LocalStorage";
import type { App } from "obsidian";
import {
	S3RN,
	type S3RNType,
	S3RemoteFile,
} from "./S3RN";
import { customFetch } from "./customFetch";
import { refresh as universalRefresh } from "./LiveTokenStoreRefresh";
import type { RelayOnPremTokenProvider } from "./auth/RelayOnPremTokenProvider";

declare const GIT_TAG: string;

function getJwtExpiryFromClientToken(clientToken: ClientToken): number {
	// lol this is so fake
	return clientToken.expiryTime || 0;
}


export class LiveTokenStore extends TokenStore<ClientToken> {
	private relayOnPremTokenProvider: RelayOnPremTokenProvider | null = null;
	private isRelayOnPremMode: boolean = false;
	private filePathMap: Map<string, string> = new Map(); // documentId -> filePath mapping

	constructor(
		private loginManager: LoginManager,
		timeProvider: TimeProvider,
		vaultName: string,
		maxConnections = 5,
		relayOnPremTokenProvider?: RelayOnPremTokenProvider,
		app?: App,
	) {
		super(
			{
				log: curryLog("[LiveTokenStore]", "debug"),
				refresh: (documentId: string, onSuccess: (clientToken: ClientToken) => void, onError: (err: Error) => void) => {
					// Get file path from map for relay-onprem mode
					const filePath = this.filePathMap.get(documentId);
					void universalRefresh(
						loginManager,
						this.relayOnPremTokenProvider,
						this.isRelayOnPremMode,
						documentId,
						onSuccess,
						onError,
						filePath
					);
				},
				getJwtExpiry: getJwtExpiryFromClientToken,
				getStorage: app
					? () => new LocalStorage<TokenInfo<ClientToken>>("TokenStore/" + vaultName, app)
					: undefined,
				getTimeProvider: () => {
					return timeProvider;
				},
			},
			maxConnections,
		);

		if (relayOnPremTokenProvider) {
			this.relayOnPremTokenProvider = relayOnPremTokenProvider;
			this.isRelayOnPremMode = true;
		}
	}

	/**
	 * Set relay-onprem mode (can be changed dynamically)
	 */
	setRelayOnPremMode(enabled: boolean, tokenProvider?: RelayOnPremTokenProvider) {
		this.isRelayOnPremMode = enabled;
		if (tokenProvider) {
			this.relayOnPremTokenProvider = tokenProvider;
		}
	}

	/**
	 * Override getToken to store file path for relay-onprem mode
	 */
	async getToken(
		documentId: string,
		friendlyName: string,
		callback: (token: ClientToken) => void,
	): Promise<ClientToken> {
		// Store the file path (friendlyName) for use during token refresh
		if (this.isRelayOnPremMode && friendlyName && friendlyName !== "unknown") {
			this.filePathMap.set(documentId, friendlyName);
		}
		return super.getToken(documentId, friendlyName, callback);
	}

	/**
	 * Override clear to also clear file path mappings
	 */
	clear(filter?: (token: TokenInfo<ClientToken>) => boolean) {
		if (filter) {
			// Clear file paths for matching tokens
			this.tokenMap?.forEach((value, key) => {
				if (filter(value)) {
					this.filePathMap.delete(key);
				}
			});
		} else {
			// Clear all file paths
			this.filePathMap.clear();
		}
		super.clear(filter);
	}

	/**
	 * Override destroy to clean up file path map
	 */
	destroy() {
		this.filePathMap.clear();
		super.destroy();
	}

	private async getFileTokenFromNetwork(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileToken> {
		const key = `${documentId}${fileHash}`;
		const activePromise = this._activePromises.get(key);
		if (activePromise) {
			return activePromise as Promise<FileToken>;
		}
		this.tokenMap.set(documentId, {
			token: null,
			expiryTime: 0,
			attempts: 0,
		} as TokenInfo<ClientToken>);
		const sharedPromise = this.fetchFileToken(
			documentId,
			fileHash,
			contentType,
			contentLength,
		)
			.then((newToken: FileToken) => {
				const expiryTime = this.getJwtExpiry(newToken);
				 
				const existing = this.tokenMap.get(key)!;
				this.tokenMap.set(fileHash, {
					...existing,
					token: newToken,
					expiryTime,
				} as TokenInfo<FileToken>);
				this._activePromises.delete(key);
				return newToken;
			})
			.catch((err: Error) => {
				this._activePromises.delete(key);
				throw err;
			});
		this._activePromises.set(key, sharedPromise);
		return sharedPromise;
	}

	async fetchFileToken(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileToken> {
		const debug = curryLog("[TokenStore][Fetch]", "debug");
		debug(`${documentId}`);
		const entity: S3RNType = S3RN.decode(documentId);
		let payload: string;
		if (entity instanceof S3RemoteFile) {
			payload = JSON.stringify({
				docId: entity.fileId,
				relay: entity.relayId,
				folder: entity.folderId,
				hash: fileHash,
				contentType,
				contentLength,
			});
		} else {
			throw new Error(`No remote to connect to for ${documentId}`);
		}
		if (!this.loginManager.loggedIn) {
			throw new Error("Not logged in");
		}
		const headers = {
			Authorization: `Bearer ${this.loginManager.user?.token}`,
			"Relay-Version": GIT_TAG,
			"Content-Type": "application/json",
		};
		const apiUrl = this.loginManager.getEndpointManager().getApiUrl();
		const response = await customFetch(`${apiUrl}/file-token`, {
			method: "POST",
			headers: headers,
			body: payload,
		});

		if (!response.ok) {
			debug(response.status, await response.text());
			const responseJSON = await response.json();
			throw new Error(responseJSON.error);
		}

		const clientToken = (await response.json()) as FileToken;
		return clientToken;
	}

	async getFileToken(
		documentId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
	): Promise<FileToken> {
		const key = `${documentId}${fileHash}`;
		const tokenInfo = this.tokenMap.get(key);
		if (tokenInfo && tokenInfo.token && this.isTokenValid(tokenInfo)) {
			this.log("token was valid, cache hit!");
			this._activePromises.delete(key);
			return Promise.resolve(tokenInfo.token as FileToken);
		}
		return this.getFileTokenFromNetwork(
			documentId,
			fileHash,
			contentType,
			contentLength,
		);
	}
}
