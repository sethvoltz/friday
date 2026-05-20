/**
 * Vitest config for the daemon's e2e suite. See
 * `packages/shared/vitest.e2e.config.ts` for the rationale.
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
