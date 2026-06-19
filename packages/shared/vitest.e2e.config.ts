/**
 * Vitest config for the e2e suite (item #50 — heavy multi-subprocess
 * tests that bring up daemon + dashboard + zero-cache).
 *
 * The default `pnpm test` excludes `*.e2e.test.ts` (see the package's
 * `test` script); this config inverts that so `pnpm test:e2e` runs
 * ONLY the e2e suite. Putting it in a config file (instead of a
 * shell glob argument) sidesteps shell globstar portability
 * differences between `pnpm` script execution contexts.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts"],
    setupFiles: ["./src/test/vitest-setup.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    // Each e2e file spawns its own subprocess set on free ports +
    // its own scratch DB. Running files in parallel works in theory
    // (free ports, unique DBs), but in practice the multi-process
    // boot hammers PG enough that two parallel boots race on
    // shared resources (max_connections, replication slot setup
    // contention). One file at a time is safer.
    fileParallelism: false,
    // Subprocess boot can be slow; let individual tests opt in to
    // longer timeouts via the third arg to `it(...)`. This is the
    // default ceiling.
    testTimeout: 60_000,
    // 180s: daemon/dashboard boot ceilings rose to 90s (matching
    // zero-cache) and waitForBoot retries once, so the serialized boot
    // chain in beforeAll can legitimately run long under load. Keep the
    // default hook ceiling above that so a slow-but-succeeding boot isn't
    // aborted before it completes. Files that set their own
    // `beforeAll(fn, HARNESS_BOOT_MS)` override this per-call.
    hookTimeout: 180_000,
  },
});
