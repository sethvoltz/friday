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
 * touch-emulating `chromium-touch` (Desktop Chrome at a desktop-width
 * viewport, overridden with `hasTouch: true`). The sidebar click-bleed
 * suite (FRI-126) needs the touch project to exercise the
 * `@media (hover: none)` always-opaque +/- slot — the platform where the
 * bug bit hardest; `devices["Desktop Chrome"]` does not set `hasTouch`,
 * so the desktop project never enters that code path.
 *
 * Why a custom touch descriptor instead of `devices["Pixel 5"]`: the
 * `@media (hover: none)` rule keys off the *pointer* capability
 * (`hasTouch`), independent of viewport width — but Pixel 5 is a 393px
 * `isMobile: true` viewport, which trips the Sidebar's own
 * `max-width: 768px` breakpoint and collapses it to a closed mobile
 * dropdown. In that layout the agent `.row` elements aren't rendered at
 * all (they live behind `{#if open}`), so the geometry assertions —
 * written against the full desktop sidebar layout — never find their
 * targets. A desktop-width viewport with `hasTouch: true` keeps the full
 * sidebar rendered AND matches `(hover: none)`, which is exactly the
 * combination FRI-126's fix guards (a touch laptop / touch-enabled
 * large screen, not a phone). Both projects share `globalSetup` so the
 * sync-env boot is paid once, not per-project.
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
      // The sidebar click-bleed suite is touch-only by construction: its
      // coordinate taps target the `@media (hover: none)` always-opaque
      // +/- slot, which `devices["Desktop Chrome"]` never reveals (no
      // `hasTouch`, slot stays `pointer-events: none` until hover). Run it
      // exclusively under `chromium-touch`; the desktop project would
      // exercise a different hit-test path than the bug lives in.
      testIgnore: /sidebar-click-targets\.spec\.ts/,
    },
    {
      // Desktop Chrome layout + `hasTouch: true`. `hasTouch` is what flips
      // the sidebar's `@media (hover: none)` slot to always-opaque and
      // routes taps through the touch synthetic-click path FRI-126 depends
      // on; the desktop-width viewport keeps the full sidebar rendered (a
      // narrow `isMobile` viewport like Pixel 5 collapses it to a closed
      // dropdown whose agent rows aren't in the DOM, so the geometry
      // assertions find nothing). Scoped to the sidebar-click-targets
      // suite only via the `chromium` project's `testIgnore` above plus
      // this `testMatch`: the appearance + live-typing suites assume a
      // pure non-touch desktop and shouldn't re-run under emulated touch.
      name: "chromium-touch",
      use: { ...devices["Desktop Chrome"], hasTouch: true, isMobile: false },
      testMatch: /sidebar-click-targets\.spec\.ts/,
    },
  ],
});
