/**
 * Regression test for the lazy server-side PostHog client (FRI-166 follow-up).
 *
 * The bug: the client was constructed at MODULE LOAD, reading POSTHOG_API_KEY
 * from `loadFridayConfig()` before the dashboard process had warmed the age
 * vault (the warm now happens in the `init` server hook, which runs AFTER this
 * module is evaluated). So the client was built with an empty key and silently
 * no-op'd all server analytics. The fix defers the config read to first use.
 *
 * This test pins the contract the fix relies on: NO config read / construction
 * at import, and construction (with the resolved key) on first access.
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
        posthogApiKey: "ph-test-key",
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
    captureException() {}
    shutdown() {
      return Promise.resolve();
    }
  },
}));

const mod = await import("./posthog.js");

describe("dashboard server posthog — lazy build", () => {
  it("does NOT read config or construct the client at module load", () => {
    expect(loadCalls.count).toBe(0);
    expect(ctorCalls.length).toBe(0);
  });

  it("builds the client on first property access, with the resolved vault key", () => {
    // Touching a method through the proxy triggers construction.
    void mod.posthog.captureException;
    expect(loadCalls.count).toBe(1);
    expect(ctorCalls).toEqual([{ key: "ph-test-key", host: "https://example.posthog.com" }]);
  });

  it("is a singleton — repeated access does not rebuild", () => {
    void mod.posthog.captureException;
    mod.initPosthog();
    expect(ctorCalls.length).toBe(1);
  });
});
