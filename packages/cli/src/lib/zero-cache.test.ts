import { afterEach, describe, expect, it } from "vitest";
import { FRIDAY_PG_CONSTANTS, type FridayEnvConfig } from "@friday/shared";
import { buildZeroCacheEnv, zeroCacheCli, zeroCacheCwd } from "./zero-cache.js";

/**
 * buildZeroCacheEnv is shared between the prod supervisor and the dev
 * launcher (`bin/dev-zero.ts`). The supervisor's own test covers the env
 * defaults via buildSpecs; these tests pin the parts the dev path adds —
 * the `dashboardPort` → ZERO_MUTATE_URL wiring (dev points it at vite's
 * :5173, prod at the dashboard port) and the secret-injection precedence
 * (fridayEnv secrets land AFTER the process.env spread, so they win).
 */

const fixtureEnv: FridayEnvConfig = {
  betterAuthSecret: "ba-secret",
  zeroAuthSecret: "za-secret",
  zeroAdminPassword: "za-admin",
  databaseUrl: "postgres://localhost/friday",
  zeroUpstreamDb: "postgres://localhost/friday",
  zeroReplicaFile: "/tmp/replica.db",
  linearApiKey: undefined,
  anthropicApiKey: undefined,
  cloudflareTunnelToken: undefined,
  posthogApiKey: undefined,
  posthogHost: undefined,
};

describe("buildZeroCacheEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    // Restore any keys the tests mutated on the live process.env.
    for (const k of ["ZERO_MUTATE_URL", "ZERO_AUTH_SECRET", "ZERO_NUM_SYNC_WORKERS"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("points ZERO_MUTATE_URL at the dev dashboard port (5173)", () => {
    const env = buildZeroCacheEnv(fixtureEnv, 5173);
    expect(env.ZERO_MUTATE_URL).toBe("http://localhost:5173/api/mutators");
  });

  it("points ZERO_MUTATE_URL at the prod dashboard port when given one", () => {
    const env = buildZeroCacheEnv(fixtureEnv, 7615);
    expect(env.ZERO_MUTATE_URL).toBe("http://localhost:7615/api/mutators");
  });

  it("injects fridayEnv secrets AFTER the process.env spread (config wins over ambient)", () => {
    process.env.ZERO_AUTH_SECRET = "stale-ambient-value";
    const env = buildZeroCacheEnv(fixtureEnv, 5173);
    expect(env.ZERO_AUTH_SECRET).toBe("za-secret");
    expect(env.ZERO_ADMIN_PASSWORD).toBe("za-admin");
    expect(env.ZERO_UPSTREAM_DB).toBe("postgres://localhost/friday");
    expect(env.ZERO_REPLICA_FILE).toBe("/tmp/replica.db");
  });

  it("defaults the single-user connection/worker pins (placed before the env spread)", () => {
    delete process.env.ZERO_NUM_SYNC_WORKERS;
    const env = buildZeroCacheEnv(fixtureEnv, 5173);
    expect(env.ZERO_NUM_SYNC_WORKERS).toBe("2");
    expect(env.ZERO_UPSTREAM_MAX_CONNS).toBe("4");
    expect(env.ZERO_CVR_MAX_CONNS).toBe("6");
    expect(env.ZERO_APP_PUBLICATIONS).toBe(FRIDAY_PG_CONSTANTS.FRIDAY_PUBLICATION);
    expect(env.ZERO_LOG_FORMAT).toBe("json");
  });

  it("omits ZERO_UPSTREAM_DB / ZERO_REPLICA_FILE when fridayEnv leaves them unset", () => {
    const env = buildZeroCacheEnv(
      { ...fixtureEnv, zeroUpstreamDb: undefined, zeroReplicaFile: undefined },
      5173,
    );
    expect("ZERO_UPSTREAM_DB" in env).toBe(false);
    expect("ZERO_REPLICA_FILE" in env).toBe(false);
  });

  it("lets an ambient ZERO_NUM_SYNC_WORKERS override the default (user value wins)", () => {
    process.env.ZERO_NUM_SYNC_WORKERS = "4";
    const env = buildZeroCacheEnv(fixtureEnv, 5173);
    expect(env.ZERO_NUM_SYNC_WORKERS).toBe("4");
  });
});

describe("zero-cache path helpers", () => {
  it("resolves the cli + cwd off the dashboard node_modules", () => {
    expect(zeroCacheCli("/repo")).toBe(
      "/repo/services/dashboard/node_modules/@rocicorp/zero/out/zero/src/cli.js",
    );
    expect(zeroCacheCwd("/repo")).toBe("/repo/services/dashboard");
  });
});
