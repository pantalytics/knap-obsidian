import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
            parserOptions: {
                sourceType: "module",
            },
        },
        rules: {
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
