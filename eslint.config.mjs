import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // oidc-provider's types are heavily nullable
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    files: ["**/adapters/**/*.ts"],
    rules: {
      // Adapter classes implement oidc-provider's async interface synchronously
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "eslint.config.mjs"],
  },
);
