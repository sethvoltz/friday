/**
 * Regression test for the lazy daemon-side PostHog client (FRI-166 follow-up).
 *
 * The bug: the client was constructed at MODULE LOAD, reading POSTHOG_API_KEY
 * from `loadFridayConfig()` during the `import` at index.ts — which runs BEFORE
 * the daemon's boot `warmVaultCache()`. So it was built with an empty key and
 * silently no-op'd all daemon analytics. The fix defers the read to first use
 * (after the boot warm, primed by `initPosthog()`).
 *
 * Pins the contract: NO config read / construction at import, and construction
 * with the resolved key on first access. (The captureFor attribution mapping is
 * covered separately in posthog.test.ts.)
 */

import { describe, expect, it, vi } from "vitest";

const loadCalls = { count: 0 };
const ctorCalls: Array<{ key: string; host?: string }> = [];

vi.mock("@friday/shared", async (importActual) => {
  const actual = await importActual<typeof import("@friday/shared")>();
  return {
    ...actual,
    loadFridayConfig: () => {
      loadCalls.count++;
      return {
        betterAuthSecret: "x",
        zeroAuthSecret: "x",
        zeroAdminPassword: "x",
        databaseUrl: undefined,
        zeroUpstreamDb: undefined,
        zeroReplicaFile: undefined,
        linearApiKey: undefined,
        anthropicApiKey: undefined,
        cloudflareTunnelToken: undefined,
        posthogApiKey: "ph-daemon-key",
        posthogHost: "https://example.posthog.com",
      };
    },
  };
});

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(key: string, opts: { host?: string }) {
      ctorCalls.push({ key, host: opts?.host });
    }
    capture() {}
    captureException() {}
    shutdown() {
      return Promise.resolve();
    }
  },
}));

const mod = await import("./posthog.js");

describe("daemon posthog — lazy build", () => {
  it("does NOT read config or construct the client at module load", () => {
    expect(loadCalls.count).toBe(0);
    expect(ctorCalls.length).toBe(0);
  });

  it("initPosthog() builds the client with the resolved vault key", () => {
    mod.initPosthog();
    expect(loadCalls.count).toBe(1);
    expect(ctorCalls).toEqual([{ key: "ph-daemon-key", host: "https://example.posthog.com" }]);
  });

  it("is a singleton — the proxy export reuses the same client, no rebuild", () => {
    void mod.posthog.flush;
    mod.initPosthog();
    expect(ctorCalls.length).toBe(1);
  });
});
