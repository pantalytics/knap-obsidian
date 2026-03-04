import type { App } from "obsidian";

/**
 * Vault-scoped localStorage Map backed by App#saveLocalStorage / App#loadLocalStorage.
 *
 * All entries are stored as a single JSON blob under `namespace` key, which Obsidian
 * automatically scopes to the current vault. This avoids direct access to the
 * restricted `localStorage` global and ensures data is vault-unique.
 */
export class LocalStorage<T> implements Map<string, T> {
	private namespace: string;
	private app: App;
	private cache: Map<string, T>;

	constructor(namespace: string, app: App) {
		this.namespace = namespace;
		this.app = app;
		this.cache = this._load();
	}

	private _load(): Map<string, T> {
		const raw = this.app.loadLocalStorage(this.namespace) as Record<string, T> | null;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			return new Map(Object.entries(raw));
		}
		return new Map();
	}

	private _persist(): void {
		const obj: Record<string, T> = {};
		this.cache.forEach((value, key) => {
			obj[key] = value;
		});
		this.app.saveLocalStorage(this.namespace, obj);
	}

	public get size(): number {
		return this.cache.size;
	}

	public clear(): void {
		this.cache.clear();
		this.app.saveLocalStorage(this.namespace, null);
	}

	public delete(key: string): boolean {
		const existed = this.cache.delete(key);
		if (existed) {
			this._persist();
		}
		return existed;
	}

	public forEach(
		callbackfn: (value: T, key: string, map: Map<string, T>) => void,
		thisArg?: unknown,
	): void {
		this.cache.forEach((value, key) => {
			callbackfn.call(thisArg, value, key, this);
		});
	}

	public get(key: string): T | undefined {
		return this.cache.get(key);
	}

	public has(key: string): boolean {
		return this.cache.has(key);
	}

	public set(key: string, value: T): this {
		this.cache.set(key, value);
		this._persist();
		return this;
	}

	public keys(): IterableIterator<string> {
		return this.cache.keys();
	}

	public values(): IterableIterator<T> {
		return this.cache.values();
	}

	public entries(): IterableIterator<[string, T]> {
		return this.cache.entries();
	}

	[Symbol.iterator](): IterableIterator<[string, T]> {
		return this.cache.entries();
	}

	get [Symbol.toStringTag](): string {
		return "LocalStorage";
	}
}
