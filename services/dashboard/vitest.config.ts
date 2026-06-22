import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [sveltekit()],
  test: {
    // CI cold-start headroom: the first test in a file absorbs module
    // transform/import time, which intermittently exceeds the 5s vitest
    // default on the slow CI runner (flaked build-dispatch-prompt + wake-lock).
    testTimeout: 20_000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts", "e2e/**"],
    setupFiles: ["../../packages/shared/src/test/vitest-setup.ts"],
    globalSetup: ["../../packages/shared/src/test/global-setup.ts"],
    // Connection-budget cap — see packages/shared/vitest.config.ts. Most
    // dashboard unit tests mock the network/PG boundary, but a few (e.g.
    // sync/refresh) use a real scratch DB; cap concurrent files so those
    // don't compound the unit-job connection pressure.
    maxWorkers: 4,
    minWorkers: 1,
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
