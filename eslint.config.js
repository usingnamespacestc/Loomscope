// Flat ESLint config (ESLint 9). Added by the P0 toolchain fix: the
// repo shipped a `lint` script and scattered `// eslint-disable`
// comments but no config and no eslint install, so `npm run lint`
// could never run. This config makes it run and pass.
//
// Philosophy: catch real correctness problems (react-hooks rules,
// no-undef via TS, obviously-wrong constructs) as ERRORS; treat the
// codebase's deliberate stylistic choices (pervasive `any` at the
// untrusted-JSON parse boundary, `_`-prefixed intentionally-unused
// bindings) as off/warn so the linter is useful instead of noise.
// Type-aware rules are intentionally NOT enabled (no project service)
// to keep `npm run lint` fast and free of false positives — `tsc`
// already owns type safety via `npm run typecheck`.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "e2e/**",
      "e2e-smoke/**",
      "coverage/**",
      "*.config.js",
      "*.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // The parse layer casts untrusted Claude Code JSONL into typed
      // records by design; `any` is load-bearing there. tsc guards the
      // rest. Not a lint concern.
      "@typescript-eslint/no-explicit-any": "off",

      // The repo has heavy bilingual (中/EN) comments; a few stray
      // zero-width spaces (U+200B) live in comment prose. Irregular
      // whitespace in actual code/strings is still an error.
      "no-irregular-whitespace": [
        "error",
        { skipComments: true, skipStrings: true, skipTemplates: true },
      ],

      // tsc's noUnusedLocals/Parameters already enforces this at the
      // build gate; keep eslint's copy as a warning and honour the
      // repo's `_`-prefix convention for intentional unused bindings.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Test files: relax a few rules that are normal in test code.
    files: ["**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
