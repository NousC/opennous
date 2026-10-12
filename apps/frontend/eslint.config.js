import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // GET-754: public code never imports the Workspace (Cloud) layer; it reads it through
  // src/lib/cloud.ts. scripts/check-cloud-imports.mjs is the CI gate; this is the editor hint.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/cloud/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["@/cloud", "@/cloud/*", "@clerk/*"],
          message: "Cloud-only code (GET-754): read it through @/lib/cloud instead.",
        }],
      }],
    },
  },
);
