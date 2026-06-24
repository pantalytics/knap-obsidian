import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import obsidianPlugin from "eslint-plugin-obsidianmd";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            obsidianmd: obsidianPlugin,
        },
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                sourceType: "module",
            },
        },
        rules: {
            ...obsidianPlugin.configs.recommended,
            // These rules require parserOptions.project (typed linting) — not enabled in this config
            "obsidianmd/no-plugin-as-component": "off",
            "obsidianmd/no-view-references-in-plugin": "off",
            "obsidianmd/prefer-file-manager-trash-file": "off",
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
        ignores: ["node_modules/", "main.js", "*.config.js"],
    }
);
