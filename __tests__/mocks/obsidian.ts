/**
 * Mock Obsidian API for Jest tests
 */

export const requestUrl = jest.fn();

export const Platform = {
	isMobile: false,
	isDesktop: true,
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
