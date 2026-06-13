/**
 * Regression test for the dashboard server `init` hook ordering (FRI-166 +
 * follow-up).
 *
 * The dashboard runs in its own process with a clean env: the supervisor
 * injects no secrets, so the dashboard must warm the age vault itself before
 * any request `load` reads a vault-backed secret (e.g. POSTHOG_API_KEY, which
 * flows to the browser via +layout.server.ts). SvelteKit awaits `ServerInit`
 * before serving any request, so as long as `init` warms the vault first, the
 * very first `load` sees the resolved key.
 *
 * The bug class this guards against: reading/caching config from an UNWARMED
 * vault (e.g. auth.ts calling loadFridayConfig() at module load) and never
 * dropping that stale empty-key cache, so every later read returns the empty
 * key. The fix is the exact ordering pinned below:
 *   1. warmVaultCache()        — populate the in-memory vault cache
 *   2. clearFridayConfigCache() — drop any config memoized pre-warm
 *   3. initPosthog()            — build the server client with the resolved key
 *
 * If a future edit reorders these (or drops a step), this test fails. Pinning
 * order — not just "all three were called" — is the point: clearing the cache
 * before the warm, or building PostHog before the clear, reintroduces the
 * empty-key bug.
 */

import { describe, expect, it, vi } from "vitest";

const callOrder: string[] = [];

vi.mock("@friday/shared", () => ({
  warmVaultCache: vi.fn(async () => {
    callOrder.push("warmVaultCache");
  }),
  clearFridayConfigCache: vi.fn(() => {
    callOrder.push("clearFridayConfigCache");
  }),
}));

vi.mock("$lib/server/posthog", () => ({
  posthog: { captureException: vi.fn() },
  DISTINCT_ID: "friday-dashboard-server",
  initPosthog: vi.fn(() => {
    callOrder.push("initPosthog");
  }),
}));

// auth.ts evaluates loadFridayConfig()/getDb() at module load — stub it out so
// importing hooks.server.ts doesn't reach the real DB or vault.
vi.mock("$lib/server/auth", () => ({ auth: { handler: vi.fn(), api: {} } }));
vi.mock("$lib/server/log", () => ({ logger: { log: vi.fn() } }));
vi.mock("@friday/shared/services", () => ({
  consumeRateLimit: vi.fn(),
  resetRateLimit: vi.fn(),
}));

const mod = await import("./hooks.server.js");

describe("dashboard server init — vault-warm ordering", () => {
  it("warms the vault, clears stale config, then builds PostHog — in that order", async () => {
    expect(mod.init).toBeTypeOf("function");
    await mod.init?.();
    expect(callOrder).toEqual(["warmVaultCache", "clearFridayConfigCache", "initPosthog"]);
  });
});
