/**
 * The file-token cache in LiveTokenStore, around one bug: the placeholder was
 * written under the document id and the result under the bare hash, while the
 * reader looked under `documentId + fileHash`. The cache could never hit, so
 * every verify, read and write of an attachment paid a fresh throttled token
 * request, and the orphaned rows sat in the persisted store until they
 * expired. These tests pin the fixed behaviour: one mint per file per token
 * lifetime, read back under the key the reader uses.
 */
import { describe, expect, jest, test } from "@jest/globals";

// An ESM-only build jest cannot load, and not on the path under test.
jest.mock("pocketbase", () => ({
	__esModule: true,
	default: class {},
	BaseAuthStore: class {},
}));

import { LiveTokenStore } from "../src/LiveTokenStore";
import type { LoginManager } from "../src/LoginManager";
import type { FileToken } from "../src/client/types";
import { MockTimeProvider } from "./mocks/MockTimeProvider";
import { S3RN, S3RemoteFile } from "../src/S3RN";
import type { RelayOnPremTokenProvider } from "../src/auth/RelayOnPremTokenProvider";

const RELAY = "11111111-1111-4111-8111-111111111111";
const FOLDER = "22222222-2222-4222-8222-222222222222";
const FILE = "33333333-3333-4333-8333-333333333333";

function makeStore(tp: MockTimeProvider) {
	const mint = jest.fn(
		async (): Promise<FileToken> => ({
			token: "file-token",
			url: "https://cp.example.com/files",
			baseUrl: "https://cp.example.com/files",
			docId: FILE,
			folder: FOLDER,
			authorization: "full",
			expiryTime: tp.getTime() + 10 * 60 * 1000,
			contentType: "image/png",
			contentLength: 3,
			fileHash: "deadbeef",
		}),
	);
	const provider = {
		requestFileToken: mint,
	} as unknown as RelayOnPremTokenProvider;
	const loginManager = { loggedIn: true } as unknown as LoginManager;
	const store = new LiveTokenStore(
		loginManager,
		tp,
		"test-vault",
		3,
		provider,
	);
	return { store, mint };
}

describe("LiveTokenStore file tokens", () => {
	test("the second ask for the same file is a cache hit", async () => {
		const tp = new MockTimeProvider();
		const { store, mint } = makeStore(tp);
		const documentId = S3RN.encode(new S3RemoteFile(RELAY, FOLDER, FILE));

		const first = await store.getFileToken(documentId, "deadbeef", "image/png", 3);
		const second = await store.getFileToken(documentId, "deadbeef", "image/png", 3);

		expect(mint).toHaveBeenCalledTimes(1);
		expect(second.token).toBe(first.token);
	});

	test("an expired file token is fetched again", async () => {
		const tp = new MockTimeProvider();
		const { store, mint } = makeStore(tp);
		const documentId = S3RN.encode(new S3RemoteFile(RELAY, FOLDER, FILE));

		await store.getFileToken(documentId, "deadbeef", "image/png", 3);
		tp.setTime(tp.getTime() + 11 * 60 * 1000);
		await store.getFileToken(documentId, "deadbeef", "image/png", 3);

		expect(mint).toHaveBeenCalledTimes(2);
	});

	test("a changed hash is a different token, not a stale hit", async () => {
		const tp = new MockTimeProvider();
		const { store, mint } = makeStore(tp);
		const documentId = S3RN.encode(new S3RemoteFile(RELAY, FOLDER, FILE));

		await store.getFileToken(documentId, "deadbeef", "image/png", 3);
		await store.getFileToken(documentId, "cafebabe", "image/png", 3);

		expect(mint).toHaveBeenCalledTimes(2);
	});
});
