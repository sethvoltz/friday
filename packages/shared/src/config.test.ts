/**
 * `resolveDaemonPort` / `resolveDashboardPort` are the canonical port
 * lookups that every cross-process port consumer uses (daemon's own
 * bind, dashboard's daemon-fetch URL, `friday status`'s display). The
 * env-override chain matters specifically because the dev wrappers set
 * `FRIDAY_DAEMON_PORT=7444` to redirect dev's dashboard at dev's
 * daemon — that resolution path must work without rebuilds or config
 * edits.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  loadConfig,
  PROD_DAEMON_PORT,
  PROD_DASHBOARD_PORT,
  resolveDaemonPort,
  resolveDashboardPort,
  type FridayConfig,
} from "./config.js";

const FULL_CFG: FridayConfig = {
  model: "claude-opus-4-7",
  daemonPort: 9999,
  dashboardPort: 8888,
  sseKeepaliveSec: 20,
  workerMemoryBudgetMb: 2048,
  mcpServers: [],
  orchestratorName: "friday",
};

describe("resolveDaemonPort", () => {
  const originalEnv = process.env.FRIDAY_DAEMON_PORT;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.FRIDAY_DAEMON_PORT;
    else process.env.FRIDAY_DAEMON_PORT = originalEnv;
  });

  it("returns the config value when env is unset", () => {
    delete process.env.FRIDAY_DAEMON_PORT;
    expect(resolveDaemonPort(FULL_CFG)).toBe(9999);
  });

  it("FRIDAY_DAEMON_PORT env overrides the config value", () => {
    process.env.FRIDAY_DAEMON_PORT = "7444";
    expect(resolveDaemonPort(FULL_CFG)).toBe(7444);
  });

  it("falls back to PROD_DAEMON_PORT when config and env are both absent", () => {
    delete process.env.FRIDAY_DAEMON_PORT;
    const cfg: FridayConfig = { ...FULL_CFG, daemonPort: undefined as unknown as number };
    expect(resolveDaemonPort(cfg)).toBe(PROD_DAEMON_PORT);
    expect(PROD_DAEMON_PORT).toBe(7610);
  });

  it("ignores a non-numeric env value and falls back to config", () => {
    process.env.FRIDAY_DAEMON_PORT = "not-a-number";
    expect(resolveDaemonPort(FULL_CFG)).toBe(9999);
  });

  it("ignores a zero or negative env value", () => {
    process.env.FRIDAY_DAEMON_PORT = "0";
    expect(resolveDaemonPort(FULL_CFG)).toBe(9999);
    process.env.FRIDAY_DAEMON_PORT = "-1";
    expect(resolveDaemonPort(FULL_CFG)).toBe(9999);
  });
});

describe("resolveDashboardPort", () => {
  it("returns the config value when set", () => {
    expect(resolveDashboardPort(FULL_CFG)).toBe(8888);
  });

  it("falls back to PROD_DASHBOARD_PORT when config is undefined", () => {
    const cfg: FridayConfig = {
      ...FULL_CFG,
      dashboardPort: undefined as unknown as number,
    };
    expect(resolveDashboardPort(cfg)).toBe(PROD_DASHBOARD_PORT);
    expect(PROD_DASHBOARD_PORT).toBe(7615);
  });

  it("does not consult FRIDAY_DAEMON_PORT (different concern)", () => {
    const originalEnv = process.env.FRIDAY_DAEMON_PORT;
    process.env.FRIDAY_DAEMON_PORT = "7444";
    try {
      expect(resolveDashboardPort(FULL_CFG)).toBe(8888);
    } finally {
      if (originalEnv === undefined) delete process.env.FRIDAY_DAEMON_PORT;
      else process.env.FRIDAY_DAEMON_PORT = originalEnv;
    }
  });
});

describe("evolve.autoSpawnTriageHelpers (FRI-40)", () => {
  // CONFIG_PATH is already bound to the scoped tmpdir FRIDAY_DATA_DIR that
  // the package's vitest-setup forces before any @friday/shared import; the
  // module imports above are what bound it. We write/clear config.json at
  // that path rather than re-binding the data dir mid-process.
  beforeEach(() => {
    if (!existsSync(dirname(CONFIG_PATH))) mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    rmSync(CONFIG_PATH, { force: true });
  });
  afterEach(() => {
    rmSync(CONFIG_PATH, { force: true });
  });

  it("DEFAULT_CONFIG ships the flag OFF by default", () => {
    expect(DEFAULT_CONFIG.evolve?.autoSpawnTriageHelpers).toBe(false);
  });

  it("loadConfig() with no config.json returns the default OFF flag", () => {
    // No file written — loadConfig clones DEFAULT_CONFIG.
    expect(loadConfig().evolve?.autoSpawnTriageHelpers).toBe(false);
  });

  it("shallow merge: a user `{ evolve: {} }` overrides the whole evolve object → flag undefined, NOT false", () => {
    // The shallow merge in loadConfig replaces DEFAULT_CONFIG.evolve wholesale
    // with the user's `{}`, so the nested default does NOT survive. This pins
    // why the daemon must read the flag with a strict `=== true` check rather
    // than relying on the default leaking through a deep merge.
    writeFileSync(CONFIG_PATH, JSON.stringify({ evolve: {} }) + "\n");
    expect(loadConfig().evolve?.autoSpawnTriageHelpers).toBeUndefined();
    expect(loadConfig().evolve?.autoSpawnTriageHelpers).not.toBe(false);
  });

  it("an explicit `{ evolve: { autoSpawnTriageHelpers: true } }` loads as true", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ evolve: { autoSpawnTriageHelpers: true } }) + "\n");
    expect(loadConfig().evolve?.autoSpawnTriageHelpers).toBe(true);
  });
});

describe("evolve.autoSpawnBuilders (FRI-149)", () => {
  beforeEach(() => {
    if (!existsSync(dirname(CONFIG_PATH))) mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    rmSync(CONFIG_PATH, { force: true });
  });
  afterEach(() => {
    rmSync(CONFIG_PATH, { force: true });
  });

  it("DEFAULT_CONFIG ships both evolve flags OFF in the SAME object (AC #5)", () => {
    // Pins that autoSpawnBuilders was added to the SAME evolve object (not a
    // sibling) and that the existing autoSpawnTriageHelpers flag is preserved.
    expect(DEFAULT_CONFIG.evolve).toEqual({
      autoSpawnTriageHelpers: false,
      autoSpawnBuilders: false,
    });
  });

  it("loadConfig() with no config.json returns the default OFF flag", () => {
    expect(loadConfig().evolve?.autoSpawnBuilders).toBe(false);
  });

  it("shallow merge: a user `{ evolve: {} }` → flag NOT === true (strict-read hazard, AC #5)", () => {
    // The shallow merge replaces DEFAULT_CONFIG.evolve wholesale with `{}`, so
    // the nested default does NOT survive — exactly why the daemon must read the
    // flag with a strict `=== true` check.
    writeFileSync(CONFIG_PATH, JSON.stringify({ evolve: {} }) + "\n");
    const cfg = loadConfig();
    expect(cfg.evolve?.autoSpawnBuilders).toBeUndefined();
    expect(cfg.evolve?.autoSpawnBuilders === true).toBe(false);
  });

  it("an explicit `{ evolve: { autoSpawnBuilders: true } }` loads as true", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ evolve: { autoSpawnBuilders: true } }) + "\n");
    expect(loadConfig().evolve?.autoSpawnBuilders).toBe(true);
  });
});
