import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CI cold-start headroom: the first test in a file absorbs module
    // transform/import time, which intermittently exceeds the 5s vitest
    // default on the slow CI runner (flaked build-dispatch-prompt + wake-lock).
    testTimeout: 20_000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    setupFiles: ["../../packages/shared/src/test/vitest-setup.ts"],
    globalSetup: ["../../packages/shared/src/test/global-setup.ts"],
    // Connection-budget cap — see packages/shared/vitest.config.ts. The
    // daemon package is the heaviest scratch-DB consumer (every listener
    // test holds a long-lived LISTEN client + a scratch DB), so bounding
    // concurrent files at 4 both fits the connection ceiling and shrinks
    // the window where one file's teardown terminate races another
    // file's still-open socket (the 57P01 unit-job flake).
    maxWorkers: 4,
    minWorkers: 1,
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
