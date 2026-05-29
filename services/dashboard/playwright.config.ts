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
 *
 * Two chromium projects: the baseline desktop `chromium` and a
 * touch-emulating `chromium-touch` (Pixel 5 descriptor → `hasTouch:
 * true`, `isMobile: true`). The sidebar click-bleed suite (FRI-126)
 * needs the touch project to exercise the `@media (hover: none)`
 * always-opaque +/- slot — the platform where the bug bit hardest;
 * `devices["Desktop Chrome"]` does not set `hasTouch`, so the desktop
 * project never enters that code path. Both projects share `globalSetup`
 * so the sync-env boot is paid once, not per-project.
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
    {
      // Pixel 5 sets isMobile + hasTouch, which is what flips the
      // sidebar's `@media (hover: none)` slot to always-opaque and
      // routes taps through the touch synthetic-click path FRI-126
      // depends on. Scoped to the sidebar-click-targets suite only: the
      // appearance + live-typing suites assume the desktop viewport
      // (the sidebar collapses to a mobile dropdown under 768px), so
      // re-running them under a 393px Pixel 5 would test a different
      // layout than they were written for. The FRI-126 suite is the one
      // that actually needs `@media (hover: none)`.
      name: "chromium-touch",
      use: { ...devices["Pixel 5"] },
      testMatch: /sidebar-click-targets\.spec\.ts/,
    },
  ],
});
