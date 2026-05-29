import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../shared/src/test/vitest-setup.ts"],
    // Connection-budget cap — see packages/shared/vitest.config.ts. evolve
    // itself doesn't open scratch DBs, but it runs concurrently with the
    // DB-heavy packages under `pnpm test`; the cap keeps total workers
    // bounded.
    maxWorkers: 4,
    minWorkers: 1,
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
