import { TokenStore } from "../src/TokenStore";
import { MockTimeProvider } from "./mocks/MockTimeProvider";
import { describe, expect, test } from "@jest/globals";

interface TestToken {
	token: string;
}

async function _testTokenStore() {
	// Setup
	const testTimeProvider = new MockTimeProvider();
	console.log(testTimeProvider);
	const mockLog = (message: string) => console.log(`Log: ${message}`);
	const mockRefresh = (
		documentId: string,
		callback: (newToken: TestToken) => void,
	) => {
		testTimeProvider.setTimeout(() => {
			callback({
				token: (testTimeProvider.getTime() + 30 * 60 * 1000).toString(),
			});
		}, 100);
	};
	const _testGetJwtExpiry = (token: TestToken) => {
		return parseInt(token.token);
	};

	const tokenStore = new TokenStore<TestToken>(
		{
			log: mockLog,
			refresh: mockRefresh,
			getTimeProvider: () => testTimeProvider,
			getJwtExpiry: _testGetJwtExpiry,
		},
		1,
	);

	// Start the TokenStore processing
	tokenStore.start();

	// Add some tokens, some of which are close to expiry
	const tokenPromise = Promise.all([
		tokenStore.getToken("doc1", "/doc1.md", () => {
			console.log("doc 1 callback");
		}),
		tokenStore.getToken("doc2", "/doc2.md", () => {
			console.log("doc 2 callback");
		}),
	]);

	// Advance time for response to happen
	testTimeProvider.setTime(testTimeProvider.getTime() + 1000); // Advance time by 1 second

	await tokenPromise;

	tokenStore.log(tokenStore.report());

	// Advance time to trigger refresh of tokens close to expiry
	testTimeProvider.setTime(testTimeProvider.getTime() + 5 * 60 * 1000); // Advance time by 5 minutes
	tokenStore.log(tokenStore.report());

	testTimeProvider.setTime(testTimeProvider.getTime() + 20 * 60 * 1000); // Advance time by 20 minutes
	tokenStore.log(tokenStore.report());
	// Stop the TokenStore processing to clean up
	tokenStore.stop();

	testTimeProvider.setTime(testTimeProvider.getTime() + 1000); // Advance time by 1 second
	testTimeProvider.setTime(testTimeProvider.getTime() + 1000); // Advance time by 1 second
	tokenStore.log(tokenStore.report());

	tokenStore.clearState();

	tokenStore.log(tokenStore.report());
}

describe("token store", () => {
	test("refresh failures increment attempts", async () => {
		const tp = new MockTimeProvider();
		const failingRefresh = (
			_id: string,
			_cb: (tok: TestToken) => void,
			errCb: (err: Error) => void,
		) => {
			errCb(new Error("fail"));
		};
		const store = new TokenStore<TestToken>(
			{
				log: () => undefined,
				refresh: failingRefresh,
				getTimeProvider: () => tp,
				getJwtExpiry: () => tp.getTime() + 1000,
			},
			1,
		);

		try {
			await store.getToken("doc1", "doc1", () => undefined);
		} catch (_) {}
		expect((store as any).tokenMap.get("doc1").attempts).toBe(1);

		try {
			await store.getToken("doc1", "doc1", () => undefined);
		} catch (_) {}

		expect((store as any).tokenMap.get("doc1").attempts).toBe(2);

		store.destroy();
	});

	function countingStore(tp: MockTimeProvider, ttlMs: number) {
		let refreshCalls = 0;
		const refresh = (
			_id: string,
			cb: (tok: TestToken) => void,
		) => {
			refreshCalls++;
			cb({ token: (tp.getTime() + ttlMs).toString() });
		};
		const store = new TokenStore<TestToken>(
			{
				log: () => undefined,
				refresh,
				getTimeProvider: () => tp,
				getJwtExpiry: (token) => parseInt(token.token),
			},
			1,
		);
		return { store, calls: () => refreshCalls };
	}

	test("warm fetches into the cache, and the real caller hits it", async () => {
		const tp = new MockTimeProvider();
		const { store, calls } = countingStore(tp, 5 * 60 * 1000);

		await store.warm("doc1", "/doc1.md");
		expect(calls()).toBe(1);
		// The warm holds no callback open, so nothing keeps refreshing it.
		expect((store as any).callbacks.has("doc1")).toBe(false);

		const token = await store.getToken("doc1", "/doc1.md", () => undefined);
		expect(calls()).toBe(1);
		expect(token.token).toBeTruthy();

		store.destroy();
	});

	test("a warmed token that is still fresh is not fetched again", async () => {
		const tp = new MockTimeProvider();
		const { store, calls } = countingStore(tp, 5 * 60 * 1000);

		await store.warm("doc1", "/doc1.md");
		await store.warm("doc1", "/doc1.md");
		expect(calls()).toBe(1);

		store.destroy();
	});

	test("a caller joining an in-flight request keeps its callback", async () => {
		const tp = new MockTimeProvider();
		let release: ((tok: TestToken) => void) | undefined;
		const refresh = (
			_id: string,
			cb: (tok: TestToken) => void,
		) => {
			release = cb;
		};
		const store = new TokenStore<TestToken>(
			{
				log: () => undefined,
				refresh,
				getTimeProvider: () => tp,
				getJwtExpiry: (token) => parseInt(token.token),
			},
			1,
		);

		const first = store.getToken("doc1", "/doc1.md", () => undefined);
		const secondCallback = jest.fn();
		const second = store.getToken("doc1", "/doc1.md", secondCallback);

		release?.({ token: (tp.getTime() + 5 * 60 * 1000).toString() });
		await Promise.all([first, second]);

		// The second caller rode the shared request, and its callback is the
		// one registered for refreshes rather than dropped on the floor.
		expect((store as any).callbacks.get("doc1")).toBe(secondCallback);
		expect(secondCallback).toHaveBeenCalled();

		store.destroy();
	});

	test("a fresh five-minute token is not immediately due for refresh", async () => {
		const tp = new MockTimeProvider();
		const { store } = countingStore(tp, 5 * 60 * 1000);

		await store.getToken("doc1", "/doc1.md", () => undefined);
		const info = (store as any).tokenMap.get("doc1");
		// The margin never spends more than half the token's life: with the
		// old fixed five-minute margin this was true from the first moment.
		expect(store.shouldRefresh(info)).toBe(false);

		// Past the halfway mark it is due.
		tp.setTime(tp.getTime() + 3 * 60 * 1000);
		expect(store.shouldRefresh(info)).toBe(true);

		store.destroy();
	});
});
