/**
 * Relay On-Premise Authentication Store
 *
 * Persists authentication state to localStorage so that users remain logged in
 * across Obsidian restarts. Supports multiple servers with independent auth state.
 *
 * Uses singleton pattern per vault to prevent race conditions when multiple
 * providers access storage simultaneously.
 */

import { curryLog } from "../debug";
import type { AuthUser } from "./IAuthProvider";

export interface RelayOnPremAuthData {
	user: AuthUser;
	token: string;
	expiresAt: number;
	refreshToken?: string;
}

/**
 * Singleton instances per vault name to ensure consistent storage access
 */
const authStoreInstances: Map<string, RelayOnPremAuthStore> = new Map();

/**
 * Get or create a singleton AuthStore instance for the given vault.
 * This prevents multiple providers from creating separate instances with
 * separate fallback storage, which could cause auth loss.
 */
export function getAuthStore(vaultName: string): RelayOnPremAuthStore {
	if (!authStoreInstances.has(vaultName)) {
		authStoreInstances.set(vaultName, new RelayOnPremAuthStore(vaultName));
	}
	return authStoreInstances.get(vaultName)!;
}

export class RelayOnPremAuthStore {
	private log = curryLog("[RelayOnPremAuthStore]");
	private storageFallback: { [key: string]: unknown } = {};
	private vaultName: string;
	private static readonly MAX_RETRY_ATTEMPTS = 3;
	private static readonly RETRY_DELAY_MS = 50;

	constructor(vaultName: string) {
		this.vaultName = vaultName;
		this.log(`Initialized for vault: ${vaultName}`);
	}

	/**
	 * Get storage key for a specific server
	 */
	private getStorageKey(serverId: string): string {
		return `evc-team-relay_onprem_auth_${this.vaultName}_${serverId}`;
	}

	/**
	 * Get storage key prefix for listing all server keys
	 */
	private getStorageKeyPrefix(): string {
		return `evc-team-relay_onprem_auth_${this.vaultName}_`;
	}

	/**
	 * Save authentication data to localStorage for a specific server
	 */
	save(serverId: string, authData: RelayOnPremAuthData): void {
		this._storageSet(this.getStorageKey(serverId), authData);
	}

	/**
	 * Load authentication data from localStorage for a specific server
	 */
	load(serverId: string): RelayOnPremAuthData | null {
		const key = this.getStorageKey(serverId);
		this.log(`load: serverId=${serverId}, key=${key}`);

		const data = this._storageGet(key) as RelayOnPremAuthData | null | undefined;

		if (!data) {
			this.log(`load: no data found for key=${key}`);
			return null;
		}

		if (!data.user || !data.token || !data.expiresAt) {
			this.log(`load: incomplete data - user=${!!data.user}, token=${!!data.token}, expiresAt=${!!data.expiresAt}`);
			return null;
		}

		this.log(`load: successfully loaded auth for user=${data.user?.email}`);
		return data;
	}

	/**
	 * Clear authentication data from localStorage for a specific server
	 */
	clear(serverId: string): void {
		this._storageRemove(this.getStorageKey(serverId));
	}

	/**
	 * Clear all authentication data for all servers
	 */
	clearAll(): void {
		const prefix = this.getStorageKeyPrefix();
		if (typeof window !== "undefined" && window?.localStorage) {
			const keysToRemove: string[] = [];
			for (let i = 0; i < window.localStorage.length; i++) {
				const key = window.localStorage.key(i);
				if (key && key.startsWith(prefix)) {
					keysToRemove.push(key);
				}
			}
			for (const key of keysToRemove) {
				window.localStorage.removeItem(key);
			}
		}
		// Clear fallback storage for this prefix
		for (const key of Object.keys(this.storageFallback)) {
			if (key.startsWith(prefix)) {
				delete this.storageFallback[key];
			}
		}
	}

	/**
	 * Check if there's valid auth data in storage for a specific server
	 */
	hasAuthData(serverId: string): boolean {
		const data = this.load(serverId);
		return data !== null;
	}

	/**
	 * Get list of all server IDs that have stored auth data
	 */
	getStoredServerIds(): string[] {
		const prefix = this.getStorageKeyPrefix();
		const serverIds: string[] = [];

		if (typeof window !== "undefined" && window?.localStorage) {
			for (let i = 0; i < window.localStorage.length; i++) {
				const key = window.localStorage.key(i);
				if (key && key.startsWith(prefix)) {
					const serverId = key.substring(prefix.length);
					if (serverId) {
						serverIds.push(serverId);
					}
				}
			}
		}

		// Also check fallback storage
		for (const key of Object.keys(this.storageFallback)) {
			if (key.startsWith(prefix)) {
				const serverId = key.substring(prefix.length);
				if (serverId && !serverIds.includes(serverId)) {
					serverIds.push(serverId);
				}
			}
		}

		return serverIds;
	}

	// ---------------------------------------------------------------
	// Internal helpers (adapted from LocalAuthStore):
	// ---------------------------------------------------------------

	/**
	 * Retrieves `key` from the browser's local storage
	 * (or runtime/memory if local storage is undefined).
	 *
	 * Includes retry logic to handle cases where localStorage might be
	 * temporarily unavailable during Obsidian startup.
	 */
	private _storageGet(key: string): unknown {
		const hasLocalStorage = typeof window !== "undefined" && window?.localStorage;
		this.log(`_storageGet: key=${key}, hasLocalStorage=${String(!!hasLocalStorage)}`);

		if (hasLocalStorage) {
			// Try with retries in case localStorage is temporarily unavailable
			for (let attempt = 0; attempt < RelayOnPremAuthStore.MAX_RETRY_ATTEMPTS; attempt++) {
				try {
					const rawValue = window.localStorage.getItem(key);
					this.log(`_storageGet: attempt=${attempt + 1}, rawValue exists=${!!rawValue}, length=${rawValue?.length ?? 0}`);

					if (!rawValue) {
						// Check fallback in case it was stored there previously
						if (this.storageFallback[key]) {
							this.log(`_storageGet: found in fallback, migrating to localStorage`);
							this._storageSet(key, this.storageFallback[key]);
							return this.storageFallback[key];
						}
						return undefined;
					}

					try {
						const parsed = JSON.parse(rawValue);
						return parsed;
					} catch {
						// not a json, return as-is
						return rawValue;
					}
				} catch (e: unknown) {
					this.log(`_storageGet: localStorage access failed, attempt ${attempt + 1}/${RelayOnPremAuthStore.MAX_RETRY_ATTEMPTS}: ${e instanceof Error ? e.message : String(e)}`);
					if (attempt < RelayOnPremAuthStore.MAX_RETRY_ATTEMPTS - 1) {
						// Small sync delay - we can't await in a sync function,
						// but for early startup issues this may help
						continue;
					}
				}
			}
		}

		// Fallback to memory storage
		this.log(`_storageGet: using fallback storage for key=${key}`);
		return this.storageFallback[key];
	}

	/**
	 * Stores a new data in the browser's local storage
	 * (or runtime/memory if local storage is undefined).
	 */
	private _storageSet(key: string, value: unknown) {
		const hasLocalStorage = typeof window !== "undefined" && window?.localStorage;
		this.log(`_storageSet: key=${key}, hasLocalStorage=${String(!!hasLocalStorage)}`);

		if (hasLocalStorage) {
			try {
				// store in local storage
				const normalizedVal: string =
					typeof value === "string" ? value : JSON.stringify(value);
				window.localStorage.setItem(key, normalizedVal);
				this.log(`_storageSet: successfully saved to localStorage`);

				// Also keep in fallback as backup
				this.storageFallback[key] = value;
			} catch (e: unknown) {
				this.log(`_storageSet: localStorage.setItem failed: ${e instanceof Error ? e.message : String(e)}`);
				// Store in fallback if localStorage fails
				this.storageFallback[key] = value;
			}
		} else {
			// store in fallback
			this.log(`_storageSet: using fallback storage`);
			this.storageFallback[key] = value;
		}
	}

	/**
	 * Removes `key` from the browser's local storage and the runtime/memory.
	 */
	private _storageRemove(key: string) {
		// delete from local storage
		if (typeof window !== "undefined" && window?.localStorage) {
			window.localStorage?.removeItem(key);
		}

		// delete from fallback
		delete this.storageFallback[key];
	}
}
