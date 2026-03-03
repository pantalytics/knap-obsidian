/**
 * Token refresh logic for LiveTokenStore
 *
 * This module provides the refresh logic that can work with both
 * System 3 API and relay-onprem control plane.
 */

import { curryLog } from "./debug";
import type { ClientToken } from "./client/types";
import { customFetch } from "./customFetch";
import {
	S3RN,
	S3RemoteDocument,
	type S3RNType,
	S3RemoteFolder,
	S3RemoteFile,
	S3RemoteCanvas,
} from "./S3RN";
import type { LoginManager } from "./LoginManager";
import type { RelayOnPremTokenProvider } from "./auth/RelayOnPremTokenProvider";

declare const GIT_TAG: string;

/**
 * Extract relay/folder/doc information from S3RN entity
 */
function extractEntityInfo(entity: S3RNType): {
	relayId: string;
	folderId: string;
	docId: string;
	filePath?: string;
} | null {
	if (entity instanceof S3RemoteDocument) {
		return {
			relayId: entity.relayId,
			folderId: entity.folderId,
			docId: entity.documentId,
			// For documents, we could potentially extract filePath from entity if needed
		};
	} else if (entity instanceof S3RemoteCanvas) {
		return {
			relayId: entity.relayId,
			folderId: entity.folderId,
			docId: entity.canvasId,
			// For canvas, we could potentially extract filePath from entity if needed
		};
	} else if (entity instanceof S3RemoteFolder) {
		return {
			relayId: entity.relayId,
			folderId: entity.folderId,
			docId: entity.folderId,
		};
	} else if (entity instanceof S3RemoteFile) {
		return {
			relayId: entity.relayId,
			folderId: entity.folderId,
			docId: entity.fileId,
			// For files, we could potentially extract filePath from entity if needed
		};
	}
	return null;
}

/**
 * Refresh token using System 3 API
 */
async function refreshSystem3(
	loginManager: LoginManager,
	documentId: string,
	onSuccess: (clientToken: ClientToken) => void,
	onError: (err: Error) => void,
) {
	const debug = curryLog("[TokenStore][Refresh][System3]", "debug");
	const error = curryLog("[TokenStore][Refresh][System3]", "error");
	debug(`${documentId}`);

	const entity: S3RNType = S3RN.decode(documentId);
	const entityInfo = extractEntityInfo(entity);

	if (!entityInfo) {
		onError(new Error("No remote to connect to"));
		return;
	}

	const payload = JSON.stringify({
		docId: entityInfo.docId,
		relay: entityInfo.relayId,
		folder: entityInfo.folderId,
	});

	if (!loginManager.loggedIn) {
		onError(Error("Not logged in"));
		return;
	}

	const headers = {
		Authorization: `Bearer ${loginManager.user?.token}`,
		"Relay-Version": GIT_TAG,
		"Content-Type": "application/json",
	};

	try {
		const apiUrl = loginManager.getEndpointManager().getApiUrl();
		const response = await customFetch(`${apiUrl}/token`, {
			method: "POST",
			headers: headers,
			body: payload,
		});

		if (!response.ok) {
			debug(response.status, await response.text());
			onError(Error(`Received status code ${response.status} from an API.`));
			return;
		}

		const clientToken = (await response.json()) as ClientToken;
		onSuccess(clientToken);
	} catch (reason: unknown) {
		error(reason, payload);
		onError(reason as Error);
	}
}

/**
 * Refresh token using relay-onprem control plane
 */
async function refreshRelayOnPrem(
	tokenProvider: RelayOnPremTokenProvider,
	documentId: string,
	onSuccess: (clientToken: ClientToken) => void,
	onError: (err: Error) => void,
	filePath?: string,
) {
	const debug = curryLog("[TokenStore][Refresh][RelayOnPrem]", "debug");
	const error = curryLog("[TokenStore][Refresh][RelayOnPrem]", "error");
	debug(`${documentId}${filePath ? ` (path: ${filePath})` : ""}`);

	const entity: S3RNType = S3RN.decode(documentId);
	const entityInfo = extractEntityInfo(entity);

	if (!entityInfo) {
		onError(new Error("No remote to connect to"));
		return;
	}

	try {
		const clientToken = await tokenProvider.requestToken(
			entityInfo.relayId,
			entityInfo.folderId,
			entityInfo.docId,
			"write", // TODO: Determine read/write based on context
			filePath // Pass file path for folder share validation
		);

		onSuccess(clientToken);
	} catch (reason: unknown) {
		error(reason);
		onError(reason as Error);
	}
}

/**
 * Universal refresh function that delegates to appropriate implementation
 */
export async function refresh(
	loginManager: LoginManager,
	tokenProvider: RelayOnPremTokenProvider | null,
	isRelayOnPremMode: boolean,
	documentId: string,
	onSuccess: (clientToken: ClientToken) => void,
	onError: (err: Error) => void,
	filePath?: string,
) {
	if (isRelayOnPremMode && tokenProvider) {
		await refreshRelayOnPrem(tokenProvider, documentId, onSuccess, onError, filePath);
	} else {
		await refreshSystem3(loginManager, documentId, onSuccess, onError);
	}
}
