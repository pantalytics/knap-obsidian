import globals from "globals";
import obsidianmd from "eslint-plugin-obsidianmd";

// eslint-plugin-obsidianmd is the same ruleset the community directory runs
// against every published version, so its own `recommended` is taken whole
// rather than cherry-picked into a `rules` block. Cherry-picking is what let
// this config sit green on 0.1.9 while the directory's scan would have failed:
// spreading `configs.recommended` into `rules` silently drops everything the
// config carries besides rule entries. See docs/catalog-submission.md.
const obsidianPlugin = obsidianmd.default ?? obsidianmd;

export default [
    ...obsidianPlugin.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.browser,
            },
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
                sourceType: "module",
            },
        },
        rules: {
            // "Knap Sync" is the product's name, so sentence case does not apply
            // to it. Declaring the brand once beats an eslint-disable at every
            // mention, which the ruleset now rejects outright anyway.
            "obsidianmd/ui/sentence-case": [
                "error",
                {
                    brands: ["Knap Sync", "Knap", "Obsidian", "GitHub", "Google", "Microsoft", "Discord"],
                    // Strings that open with a number: the rule reads the word
                    // after the digits as the first word of the sentence and
                    // asks for "30 Days", which is title case, not sentence
                    // case. Our copy already says "30 days". Exempting beats
                    // breaking correct English to satisfy the check.
                    ignoreRegex: ["^\\d"],
                },
            ],
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": ["error", { args: "none", caughtErrorsIgnorePattern: "^_" }],
            "@typescript-eslint/ban-ts-comment": "off",
            "no-prototype-builtins": "off",
            "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        {
                            name: "fs",
                            message: "Do not use Node's fs module.",
                        },
                        {
                            name: "path",
                            message: "Do not use Node's path module.",
                        },
                        {
                            name: "http",
                            message: "Do not use Node's http module.",
                        },
                        {
                            name: "crypto",
                            message: "Do not use Node's crypto module.",
                        },
                    ],
                },
            ],
        },
    },
    {
        // Test and build files need Node.js built-ins and have different conventions
        files: ["__tests__/**/*", "esbuild.config.mjs", "version-bump.mjs", "debug-tools/**/*"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-restricted-imports": "off",
            "@typescript-eslint/no-unused-vars": "warn",
            "no-empty": "warn",
            "obsidianmd/hardcoded-config-path": "off",
        },
    },
    {
        ignores: ["node_modules/", "main.js", "*.config.js", "coverage/"],
    },
];
