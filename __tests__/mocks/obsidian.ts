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
