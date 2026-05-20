/**
 * Vitest config for the dashboard's e2e suite. See
 * `packages/shared/vitest.e2e.config.ts` for the rationale.
 *
 * The dashboard's normal `vite.config.ts` loads SvelteKit's vite
 * plugin; for the e2e tests we don't want that (the tests drive
 * subprocesses, not the dev server). Override here with a vitest-
 * only config that has no plugins.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
