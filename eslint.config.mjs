// FRI-117: eslint flat config (eslint 9+). Rules selected to catch the
// FRI-110-shape "trust the chain" class plus the type-aware promise +
// switch-exhaustiveness rules that catch authoring-time silent-omission
// bugs. Prettier owns formatting.
//
// Scope notes:
// - Type-aware rules (`no-floating-promises`, `no-misused-promises`,
//   `switch-exhaustiveness-check`) run via the project-service mode of
//   typescript-eslint, which loads each touched file's nearest
//   tsconfig automatically — no per-package `parserOptions.project`
//   list maintenance.
// - Tests run with vitest globals; the `*.test.ts` override block
//   relaxes the rules that bite mock-heavy patterns.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.svelte-kit/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/build/**",
      "**/coverage/**",
      "packages/shared/drizzle/**", // generated migrations
      "services/dashboard/static/**",
      "services/dashboard/.svelte-kit/**",
      "services/dashboard/build/**",
      "**/*.svelte", // svelte files handled by `pnpm --filter @friday/dashboard check`
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Default language options apply to .js/.mjs/.cjs/.ts files alike;
  // every entry point in this monorepo runs in node, with browser
  // surface limited to SvelteKit code that lives behind the
  // `.svelte` ignore + the svelte-check job.
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser, // for fetch/Response/etc. used in @friday/shared
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
      parserOptions: {
        // Each package's tsconfig.json EXCLUDES `src/**/*.test.ts`
        // (Vitest transpiles tests directly; the build output skips
        // them). typescript-eslint's project-service mode otherwise
        // can't load test files for type-aware rules. Point it at the
        // root-level `tsconfig.eslint.json` which includes the test
        // files + config files + e2e + scripts as a single shadow
        // project — type-aware rules run with full project context.
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // FRI-117 core rules: catch authoring-time fall-through / silent
      // omission patterns. Per-rule rationale matches the FRI-110-shape
      // discussion in the ticket.
      "no-fallthrough": "error",
      "default-case-last": "error",
      "no-unused-vars": "off", // shadowed by the TS variant below
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-useless-assignment": "error",
      "preserve-caught-error": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": false,
          "ts-nocheck": false,
          "ts-check": false,
        },
      ],
      // `any` stays warn for legacy code; a follow-up sweep promotes
      // to error after the remaining ~80 hits are typed or escape-
      // hatched.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
      "@typescript-eslint/no-require-imports": "off",
      // Type-aware rules: catch silent-omission patterns the FRI-110
      // class lives in. `no-floating-promises` is the structural form
      // of "you started an async op without `await`ing or `void`-
      // discarding it"; `no-misused-promises` catches `if (asyncFn())`
      // / `setTimeout(asyncFn, ...)` shapes. The `void` operator and
      // an explicit `.catch(...)` are both acceptable discards.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true, ignoreIIFE: true }],
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          allowDefaultCaseForExhaustiveSwitch: true,
          considerDefaultExhaustiveForUnions: true,
        },
      ],
    },
  },
  // Tests: mock-heavy patterns need `any` and untyped callback shapes.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/test/**/*.ts", "**/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // JS / config files: skip TS-specific rules entirely.
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // Prettier compatibility: disable formatting-related rules so
  // prettier is the sole owner of whitespace + line wraps.
  prettierConfig,
);
