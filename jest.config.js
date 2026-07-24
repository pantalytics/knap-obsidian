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
