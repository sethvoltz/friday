/**
 * Vitest config for @friday/memory's e2e suite (FRI-24 embed real-fork tests).
 * Mirrors services/daemon/vitest.e2e.config.ts.
 *
 * These tests `fork` the BUILT dist/embed-child.js, so `pnpm test:e2e` runs
 * after `build` (turbo's test:e2e dependsOn build). Loads the shared vitest
 * setup so FRIDAY_DATA_DIR never resolves to the user's real ~/.friday/.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts"],
    setupFiles: ["../shared/src/test/vitest-setup.ts"],
    globalSetup: ["../shared/src/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
