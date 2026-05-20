/**
 * Playwright config for the dashboard's browser-driven e2e suite
 * (item #50, plan §4 step 4e — the user-visible convergence test
 * that replaced the dropped synthetic two-Zero-client suite).
 *
 * `globalSetup` brings up the full sync env once (daemon + dashboard
 * + zero-cache + scratch DB) and writes the live URL to a per-run
 * JSON file so the tests can read it. `globalTeardown` drops the
 * scratch DB and SIGTERMs every subprocess.
 *
 * Headless chromium only. Other browsers would re-test
 * @sveltejs/kit's bundle output, which the Svelte test suite already
 * covers; we're testing Friday-specific behavior (the auth-cookie
 * gate + Zero round-trip), not browser compatibility.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // The full sync env boot is ~3-5s; tests should finish in <30s.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The harness spins up real subprocesses with real ports; running
  // tests in parallel within one file would race on the same env.
  // Vitest's --no-file-parallelism equivalent: workers=1.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",

  // globalSetup returns its own cleanup function; no separate
  // globalTeardown file needed.
  globalSetup: "./e2e/global-setup.ts",

  use: {
    // The base URL is filled in by globalSetup → env.json → tests.
    // Setting it here keeps the test bodies short.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
