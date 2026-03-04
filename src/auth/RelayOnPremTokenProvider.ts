/**
 * Relay On-Premise Token Provider
 *
 * This provider fetches relay access tokens from the relay-onprem control plane.
 * It replaces the System 3 /token endpoint with relay-onprem /tokens/relay endpoint.
 */

import { customFetch } from "../customFetch";
import { curryLog } from "../debug";
import type { ClientToken } from "../client/types";
import type { IAuthProvider } from "./IAuthProvider";

export interface RelayTokenRequest {
	share_id: string;
	doc_id: string;
	mode: "read" | "write";
	password?: string;
	file_path?: string; // For folder shares: path of file within folder
}

export interface RelayTokenResponse {
	relay_url: string;
	token: string;
	expires_at: string;
}

export interface RelayOnPremTokenConfig {
	controlPlaneUrl: string;
	authProvider: IAuthProvider;
}

export class RelayOnPremTokenProvider {
	private log = curryLog("[RelayOnPremTokenProvider]");
	private normalizedUrl: string;

	constructor(private config: RelayOnPremTokenConfig) {
		// Normalize URL - remove trailing slashes to prevent double-slash issues
		this.normalizedUrl = config.controlPlaneUrl.replace(/\/+$/, "");
	}

	/**
	 * Request a relay token for document access
	 */
	async requestToken(
		relayId: string,
		folderId: string,
		docId: string,
		mode: "read" | "write" = "read",
		filePath?: string
	): Promise<ClientToken> {
		const token = await this.config.authProvider.getValidToken();

		if (!token) {
			throw new Error("Not authenticated");
		}

		this.log(`Requesting relay token for doc ${docId} in folder ${folderId}${filePath ? ` (file: ${filePath})` : ""}`);

		const request: RelayTokenRequest = {
			share_id: folderId, // In relay-onprem, folder maps to share
			doc_id: docId,
			mode,
		};

		// Include file_path for folder shares if provided
		if (filePath) {
			request.file_path = filePath;
		}

		try {
			const response = await customFetch(
				`${this.normalizedUrl}/tokens/relay`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify(request),
				}
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Token request failed: ${response.status} - ${errorText}`);
			}

			const data: RelayTokenResponse = await response.json();

			// Convert to ClientToken format expected by the plugin
			const expiresAt = new Date(data.expires_at);
			const clientToken: ClientToken = {
				token: data.token,
				url: data.relay_url,
				docId: docId,
				folder: folderId,
				expiryTime: expiresAt.getTime(),
				authorization: mode === "write" ? "full" : "read-only",
			};

			this.log(`Successfully obtained relay token, expires at ${data.expires_at}`);

			return clientToken;
		} catch (error: unknown) {
			this.log("Token request error:", error);
			throw error;
		}
	}

	/**
	 * Request a file token for attachment access
	 * Note: relay-onprem may need a separate endpoint for this
	 */
	async requestFileToken(
		relayId: string,
		folderId: string,
		fileId: string,
		fileHash: string,
		contentType: string,
		contentLength: number,
		filePath?: string
	): Promise<ClientToken> {
		// For now, use the same endpoint as document tokens
		// TODO: Implement separate file token endpoint if needed
		return this.requestToken(relayId, folderId, fileId, "read", filePath);
	}
}
