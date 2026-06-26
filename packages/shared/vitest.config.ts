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
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    setupFiles: ["./src/test/vitest-setup.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    // Connection-budget cap. Every scratch-DB test file creates its own
    // `friday_test_*` database and opens a daemon pool (max 10) plus raw
    // LISTEN clients. Under the unit `Tests` job's Postgres
    // (max_connections raised to 200 in ci.yml) unbounded fork
    // parallelism could still exhaust connections — and more workers
    // means more cross-file `pg_terminate_backend` races (the 57P01
    // teardown amplifier). Cap concurrent files at 4 so the connection
    // ceiling has comfortable headroom. Files still run in parallel; we
    // just bound how many at once.
    maxWorkers: 4,
    minWorkers: 1,
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
