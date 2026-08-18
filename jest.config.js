//module.exports = {
//  preset: 'ts-jest',
//  testEnvironment: 'node',
//};
//
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	// [...]
	preset: "ts-jest/presets/default-esm", // or other ESM presets
	// polyfill window.* browser APIs in Node.js test environment
	setupFiles: ["<rootDir>/__tests__/jest.setup.js"],
	forceExit: true,
	moduleNameMapper: {
		"^(\\.{1,2}/.*)\\.js$": "$1",
		"^src/(.*)$": "<rootDir>/src/$1",
		"^obsidian$": "<rootDir>/__tests__/mocks/obsidian.ts",
	},
	testPathIgnorePatterns: ["/__tests__/mocks/", "/__tests__/jest.setup.js"],
    globals: {
        "BUILD_TYPE": "production",
        "GIT_TAG": "test",
        // Match esbuild.config.mjs: this build compiles both empty (relay-onprem
        // only, no System3 cloud backend) — see TR-58.
        "API_URL": "",
        "AUTH_URL": "",
        // The one Knap server's address, defined at build time by
        // esbuild.config.mjs (ADR-0033). A test address rather than the real
        // one, so a test that passes only against production fails here.
        "CONTROL_PLANE_URL": "https://cp.knap.test",
        // Knap's own page, behind the Dashboard button. A test address for the
        // same reason as the line above.
        "PANEL_URL": "https://knap.test/sync",
        // The rebuild's beta switch: off under jest, like every ordinary build.
        "KNAP_SERVER_URL": "",
    },
	transform: {
		".ts": [
			"ts-jest",
			{
				// Note: We shouldn't need to include `isolatedModules` here because it's a deprecated config option in TS 5,
				// but setting it to `true` fixes the `ESM syntax is not allowed in a CommonJS module when
				// 'verbatimModuleSyntax' is enabled` error that we're seeing when running our Jest tests.
				isolatedModules: true,
				useESM: true,
			},
		],
	},
};
