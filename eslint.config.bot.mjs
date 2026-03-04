// ESLint config matching ObsidianReviewBot expectations
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.js",
						"manifest.json",
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...tseslint.configs.recommendedTypeChecked,
	{
		plugins: {
			obsidianmd: obsidianmd,
		},
		rules: {
			...obsidianmd.configs.recommended,
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-empty-function": "off",
			// Suppress rules the bot didn't flag
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-redundant-type-constituents": "off",
			"@typescript-eslint/no-base-to-string": "off",
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
			"@typescript-eslint/await-thenable": "off",
			// Keep the rules the bot DID flag
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/require-await": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/restrict-template-expressions": "error",
			"@typescript-eslint/unbound-method": "error",
			"@typescript-eslint/no-unsafe-enum-comparison": "error",
			"@typescript-eslint/prefer-promise-reject-errors": "error",
			"no-prototype-builtins": "error",
		},
	},
	// Bot doesn't apply @typescript-eslint/unbound-method to JS files
	{
		files: ["**/*.js"],
		rules: {
			"@typescript-eslint/unbound-method": "off",
		},
	},
	{
		ignores: [
			"node_modules/",
			"main.js",
			"*.config.js",
			"*.config.mjs",
			"esbuild.config.mjs",
		],
	},
);
