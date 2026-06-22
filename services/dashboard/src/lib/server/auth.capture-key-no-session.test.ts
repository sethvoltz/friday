/**
 * FRI-171 (ADR-047) — pins the SECURITY-CRITICAL apiKey-plugin config (AC4):
 * a Capture key authenticates a stateless POST, it does NOT mint a session.
 *
 * With `enableSessionForAPIKeys: false` the plugin never mocks a session for a
 * request bearing `x-api-key` (the plugin's onRequest hook short-circuits when
 * the flag is false — `index.mjs:2130 if (!config.enableSessionForAPIKeys) continue;`).
 * If a future edit flips this to `true`, any device-scoped write key would
 * become a full login bypass. This test fails the moment the flag is dropped or
 * set true.
 *
 * We mock `betterAuth` and `apiKey` so importing `auth.ts` doesn't reach the
 * real DB/vault — auth.ts calls `getDb()`/`loadFridayConfig()` at module load.
 * We capture the exact arguments auth.ts hands to `apiKey()` and to
 * `betterAuth()` and assert on them directly.
 */

import { describe, expect, it, vi } from "vitest";

const apiKeyArgs: unknown[] = [];
const betterAuthArgs: unknown[] = [];

vi.mock("@better-auth/api-key", () => ({
  apiKey: (opts: unknown) => {
    apiKeyArgs.push(opts);
    return { id: "api-key" };
  },
}));

vi.mock("better-auth", () => ({
  betterAuth: (cfg: unknown) => {
    betterAuthArgs.push(cfg);
    return { __mock: true };
  },
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: () => ({ __adapter: true }),
}));

vi.mock("$app/environment", () => ({ dev: false }));

vi.mock("@friday/shared", () => ({
  getDb: () => ({ __db: true }),
  loadConfig: () => ({ publicUrl: undefined }),
  loadFridayConfig: () => ({ betterAuthSecret: "test-secret" }),
  PROD_DASHBOARD_PORT: 7615,
  resolveDashboardPort: () => 7615,
  schema: {},
}));

const authModule = await import("./auth.js");
// `auth` is a lazy Proxy (construction is deferred past SvelteKit's DB-free
// build-time `analyse` pass), so `apiKey()`/`betterAuth()` don't run until the
// proxy is first touched. Touch it here to force construction and capture args.
void authModule.auth.handler;

interface ApiKeyOpts {
  enableSessionForAPIKeys?: boolean;
  permissions?: { defaultPermissions?: Record<string, string[]> };
  apiKeyHeaders?: string | string[];
}

interface BetterAuthCfg {
  plugins?: unknown[];
}

describe("apiKey plugin config — Capture keys mint no session (AC4)", () => {
  it("passes enableSessionForAPIKeys: false to the apiKey plugin", () => {
    expect(apiKeyArgs).toHaveLength(1);
    const opts = apiKeyArgs[0] as ApiKeyOpts;
    expect(opts.enableSessionForAPIKeys).toBe(false);
  });

  it("scopes the default Capture key permission to capture:[write]", () => {
    const opts = apiKeyArgs[0] as ApiKeyOpts;
    expect(opts.permissions?.defaultPermissions).toEqual({ capture: ["write"] });
  });

  it("reads the raw key from the x-api-key header", () => {
    const opts = apiKeyArgs[0] as ApiKeyOpts;
    expect(opts.apiKeyHeaders).toBe("x-api-key");
  });

  it("registers the apiKey plugin in the betterAuth plugins array", () => {
    expect(betterAuthArgs).toHaveLength(1);
    const cfg = betterAuthArgs[0] as BetterAuthCfg;
    expect(Array.isArray(cfg.plugins)).toBe(true);
    expect(cfg.plugins).toContainEqual({ id: "api-key" });
  });
});
