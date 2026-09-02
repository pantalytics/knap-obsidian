/**
 * Mock Obsidian API for Jest tests
 */

export const requestUrl = jest.fn();

/**
 * Minimal standin for Obsidian's `debounce()` (real signature: cb, timeout,
 * resetTimer). Trailing-edge only (fires `cb` once `timeout` ms after the
 * last call when resetTimer=true, which is the only mode this repo uses).
 * Real `setTimeout` under the hood so callers can drive it with Jest fake
 * timers (`jest.useFakeTimers()` + `jest.advanceTimersByTime()`).
 */
export function debounce<T extends unknown[], V>(
	cb: (...args: T) => V,
	timeout = 0,
	resetTimer = false
): ((...args: T) => void) & { cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pendingArgs: T | null = null;

	const debounced = ((...args: T): void => {
		pendingArgs = args;
		if (timer && resetTimer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!timer) {
			timer = setTimeout(() => {
				timer = null;
				const args2 = pendingArgs;
				pendingArgs = null;
				if (args2) cb(...args2);
			}, timeout);
		}
	}) as ((...args: T) => void) & { cancel: () => void };

	debounced.cancel = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		pendingArgs = null;
	};

	return debounced;
}

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
};

export interface RequestUrlParam {
	url: string;
	method?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: any;
	text: string;
}

export const normalizePath = (path: string): string =>
	path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");

export class TFile {
	path: string;
	basename: string;
	extension: string;
	name: string;
	stat: { mtime: number; ctime: number; size: number };

	constructor(path: string) {
		this.path = path;
		const parts = path.split("/");
		this.name = parts[parts.length - 1];
		const extIdx = this.name.lastIndexOf(".");
		this.basename = extIdx >= 0 ? this.name.substring(0, extIdx) : this.name;
		this.extension = extIdx >= 0 ? this.name.substring(extIdx + 1) : "";
		this.stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
	}
}

export class TFolder {
	path: string;
	name: string;
	children: (TFile | TFolder)[];

	constructor(path: string, children: (TFile | TFolder)[] = []) {
		this.path = path;
		const parts = path.split("/");
		this.name = parts[parts.length - 1];
		this.children = children;
	}
}

export class Vault {}

/** Records every Notice construction so tests can assert on it. Reset with noticeMock.mockClear(). */
export const noticeMock = jest.fn<(message: string, timeout?: number) => void>();

export class Notice {
	message: string;
	timeout?: number;

	constructor(message: string, timeout?: number) {
		this.message = message;
		this.timeout = timeout;
		noticeMock(message, timeout);
	}
}

/**
 * Enough of a Modal for a module that extends one to load. Nothing here
 * draws: the modal in `src/knap/LinkProgressModal.ts` keeps its rules in
 * `linkSteps.ts`, which is pure and tested on its own.
 */
export class Modal {
	app: unknown;
	contentEl: unknown = {};
	constructor(app: unknown) {
		this.app = app;
	}
	open(): void {}
	close(): void {}
}

export const setIcon = jest.fn();
