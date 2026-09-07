import tseslint from "typescript-eslint";
import globals from "globals";
export default tseslint.config(
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js", "manifest.json"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
    },
  },
  { ignores: ["node_modules/", "main.js", "*.config.mjs"] }
);
