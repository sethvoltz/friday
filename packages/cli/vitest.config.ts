import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../shared/src/test/vitest-setup.ts"],
    // Connection-budget cap — see packages/shared/vitest.config.ts.
    maxWorkers: 4,
    minWorkers: 1,
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
