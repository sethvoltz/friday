/**
 * Vitest config for the daemon's e2e suite. See
 * `packages/shared/vitest.e2e.config.ts` for the rationale.
 *
 * Loads the shared vitest setup file to guarantee FRIDAY_DATA_DIR
 * never resolves to the user's real ~/.friday/ (see vitest-setup.ts).
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts"],
    setupFiles: ["../../packages/shared/src/test/vitest-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
