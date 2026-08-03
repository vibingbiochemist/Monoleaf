import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "src-tauri",
      "node_modules",
      "patches",
      "scripts",
      "*.config.js",
      "*.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  // The end-to-end harness runs in Node, not the webview: it spawns the built
  // binary and inspects it from outside, so it needs Node's globals rather than
  // the browser's.
  {
    files: ["e2e/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Keep formatting concerns entirely with Prettier.
  prettier,
);
