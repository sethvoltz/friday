import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CI cold-start headroom: the first test in a file absorbs module
    // transform/import time, which intermittently exceeds the 5s vitest
    // default on the slow CI runner (flaked build-dispatch-prompt + wake-lock).
    testTimeout: 20_000,
    // Same cold-start headroom for beforeAll/beforeEach: a `createTestDb`
    // (scratch Postgres + full migrations) or heavy dynamic imports inside a
    // hook can exceed vitest's 10s hook default on a cold runner (flaked
    // evolve-dreaming.test.ts's beforeAll).
    hookTimeout: 20_000,
    // *.e2e.test.ts are heavy real-fork suites — excluded from the unit run
    // (pnpm test), exercised via `pnpm test:e2e` (vitest.e2e.config.ts).
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    setupFiles: ["../shared/src/test/vitest-setup.ts"],
    globalSetup: ["../shared/src/test/global-setup.ts"],
    // Connection-budget cap — see packages/shared/vitest.config.ts.
    maxWorkers: 4,
    minWorkers: 1,
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
