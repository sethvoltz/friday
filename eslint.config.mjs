// FRI-117: eslint flat config (eslint 9+). Rules selected to catch the
// FRI-110-shape "trust the chain" class without being so noisy that
// every PR fights formatter churn — prettier owns formatting.
//
// Scope notes:
// - Type-aware rules (e.g. `no-floating-promises`) require a
//   `parserOptions.project` pointing at the package's tsconfig.
//   Enabling those across the workspace requires every tsconfig to
//   include test files. Initial rollout keeps the type-aware rules
//   OFF; a follow-up tightens to the project-graph form once every
//   package's tsconfig is verified to include test paths.
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
      // Unused vars: warn (not error) for the initial rollout — there
      // is real cleanup work (~10 dead imports across the workspace);
      // tightening to error is a follow-up after a sweep PR.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // These two are opinionated rules from eslint 9's recommended
      // set that fire on patterns the existing codebase uses
      // intentionally. Warn for visibility; tightening to error is a
      // follow-up sweep, not a blocker for landing the config.
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": false,
          "ts-nocheck": false,
          "ts-check": false,
        },
      ],
      // `any` is overused in places that pre-date the FSM-style typing
      // work; surface as a warning so new code biases away from it
      // without forcing a workspace-wide rewrite in this PR.
      "@typescript-eslint/no-explicit-any": "warn",
      // Empty object type (`{}`) was a footgun in TS<4.9; allow with
      // `Record<string, never>` for the genuine empty-object case.
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
      // `require` is fine in scripts/ and explicit Node entry points;
      // the bulk of the source is ESM and never hits this rule.
      "@typescript-eslint/no-require-imports": "off",
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
