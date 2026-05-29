import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    setupFiles: ["./src/test/vitest-setup.ts"],
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
