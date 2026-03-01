/**
 * Check if a server URL belongs to Entire VC infrastructure.
 */
export function isEntireVCServer(serverUrl: string): boolean {
	try {
		const host = new URL(serverUrl).hostname;
		return host === "entire.vc" || host.endsWith(".entire.vc");
	} catch {
		return false;
	}
}
