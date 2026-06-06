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
  autoCompactWindowFor,
  coerceLegacyModelId,
  compactionSweepHour,
  compactionSweepMinute,
  compactionSweepThreshold,
  CONFIG_PATH,
  DEFAULT_AUTO_COMPACT_WINDOW,
  DEFAULT_COMPACTION_SWEEP,
  DEFAULT_CONFIG,
  DEFAULT_WATCHDOG_THRESHOLDS_MS,
  loadConfig,
  PROD_DAEMON_PORT,
  PROD_DASHBOARD_PORT,
  resolveDaemonPort,
  resolveDashboardPort,
  resolveModelForEvolveTask,
  resolveModelForRole,
  watchdogThresholdMs,
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

describe("per-role / per-evolve-task model resolution (FRI-16)", () => {
  // AC #2 — six resolver cases. Each pins the exact ModelConfig shape so a
  // regression in fallback order (override vs global) or in ModelConfig
  // pass-through (thinking / effort dropped) is caught.

  it("resolveModelForRole falls through to cfg.model when no override is set", () => {
    const cfg: FridayConfig = { ...FULL_CFG, model: "claude-opus-4-7" };
    expect(resolveModelForRole(cfg, "builder")).toEqual({ name: "claude-opus-4-7" });
  });

  it("resolveModelForRole returns the per-role string override", () => {
    const cfg: FridayConfig = {
      ...FULL_CFG,
      model: "claude-opus-4-7",
      models: { builder: "claude-sonnet-4-6" },
    };
    expect(resolveModelForRole(cfg, "builder")).toEqual({ name: "claude-sonnet-4-6" });
  });

  it("resolveModelForRole passes a full ModelConfig override through verbatim", () => {
    const cfg: FridayConfig = {
      ...FULL_CFG,
      model: "x",
      models: {
        builder: {
          name: "claude-sonnet-4-6",
          thinking: { type: "enabled", budgetTokens: 4000 },
          effort: "high",
        },
      },
    };
    expect(resolveModelForRole(cfg, "builder")).toEqual({
      name: "claude-sonnet-4-6",
      thinking: { type: "enabled", budgetTokens: 4000 },
      effort: "high",
    });
  });

  it("resolveModelForRole does NOT leak another role's override", () => {
    const cfg: FridayConfig = {
      ...FULL_CFG,
      model: "claude-opus-4-7",
      models: { helper: "claude-haiku-4-5-20251001" },
    };
    expect(resolveModelForRole(cfg, "builder")).toEqual({ name: "claude-opus-4-7" });
    expect(resolveModelForRole(cfg, "planner")).toEqual({ name: "claude-opus-4-7" });
  });

  it("resolveModelForEvolveTask falls through to cfg.model when no override is set", () => {
    const cfg: FridayConfig = { ...FULL_CFG, model: "claude-opus-4-7" };
    expect(resolveModelForEvolveTask(cfg, "enrich")).toEqual({ name: "claude-opus-4-7" });
  });

  it("resolveModelForEvolveTask returns the per-task string override", () => {
    const cfg: FridayConfig = {
      ...FULL_CFG,
      model: "claude-opus-4-7",
      evolve: { models: { enrich: "claude-sonnet-4-6" } },
    };
    expect(resolveModelForEvolveTask(cfg, "enrich")).toEqual({ name: "claude-sonnet-4-6" });
  });

  it("resolveModelForEvolveTask passes a full ModelConfig override through verbatim", () => {
    const cfg: FridayConfig = {
      ...FULL_CFG,
      model: "x",
      evolve: {
        models: {
          enrich: {
            name: "claude-sonnet-4-6",
            thinking: { type: "enabled", budgetTokens: 4000 },
            effort: "high",
          },
        },
      },
    };
    expect(resolveModelForEvolveTask(cfg, "enrich")).toEqual({
      name: "claude-sonnet-4-6",
      thinking: { type: "enabled", budgetTokens: 4000 },
      effort: "high",
    });
  });

  it("resolveModelForEvolveTask does NOT leak another task's override", () => {
    const cfg: FridayConfig = {
      ...FULL_CFG,
      model: "claude-opus-4-7",
      evolve: { models: { scanFriction: "claude-haiku-4-5-20251001" } },
    };
    expect(resolveModelForEvolveTask(cfg, "enrich")).toEqual({ name: "claude-opus-4-7" });
  });

  it("AC #5: DEFAULT_CONFIG is unchanged — `models` and `evolve.models` stay absent", () => {
    expect(DEFAULT_CONFIG.models).toBeUndefined();
    expect(DEFAULT_CONFIG.evolve?.models).toBeUndefined();
    // Full-shape pin: opting into per-role models must be an explicit user
    // action, never a shipped default.
    expect(DEFAULT_CONFIG).toEqual({
      model: "claude-opus-4-7",
      daemonPort: PROD_DAEMON_PORT,
      dashboardPort: PROD_DASHBOARD_PORT,
      sseKeepaliveSec: 20,
      workerMemoryBudgetMb: 2048,
      mcpServers: [],
      orchestratorName: "friday",
      watchdog: { refork: true },
      evolve: { autoSpawnTriageHelpers: false, autoSpawnBuilders: false },
    });
  });

  it("loadConfig() on a config.json without the new fields returns the same shape as today", () => {
    if (!existsSync(dirname(CONFIG_PATH))) mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ model: "claude-opus-4-7" }) + "\n");
    try {
      const cfg = loadConfig();
      expect(cfg.models).toBeUndefined();
      expect(cfg.evolve?.models).toBeUndefined();
      expect(resolveModelForRole(cfg, "orchestrator")).toEqual({ name: "claude-opus-4-7" });
    } finally {
      rmSync(CONFIG_PATH, { force: true });
    }
  });
});

describe("planner watchdog threshold (FRI-16 AC #5b)", () => {
  it("DEFAULT_WATCHDOG_THRESHOLDS_MS gives planner the scheduled-class threshold", () => {
    expect(DEFAULT_WATCHDOG_THRESHOLDS_MS.planner).toBe(3_600_000);
  });

  it("watchdogThresholdMs(undefined, 'planner') === 3_600_000", () => {
    expect(watchdogThresholdMs(undefined, "planner")).toBe(3_600_000);
  });

  it("a config override still wins for planner", () => {
    expect(watchdogThresholdMs({ thresholdsMs: { planner: 120_000 } }, "planner")).toBe(120_000);
  });
});

describe("coerceLegacyModelId (FRI-16 AC #22b)", () => {
  it("coerces the legacy un-dated Haiku id to the dated snapshot", () => {
    expect(coerceLegacyModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5-20251001");
  });

  it("is idempotent — the dated id passes through unchanged", () => {
    expect(coerceLegacyModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });

  it("leaves every other id untouched", () => {
    expect(coerceLegacyModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(coerceLegacyModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
});

describe("compaction config (FRI-156 §A/§B)", () => {
  beforeEach(() => {
    if (!existsSync(dirname(CONFIG_PATH))) mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    rmSync(CONFIG_PATH, { force: true });
  });
  afterEach(() => {
    rmSync(CONFIG_PATH, { force: true });
  });

  it("DEFAULT_CONFIG does NOT populate `compaction` (resolved via helpers, not deep-merge)", () => {
    // Mirrors watchdogThresholdMs: the defaults live in the resolvers + the
    // DEFAULT_* consts, NOT in DEFAULT_CONFIG, so a partial user override
    // resolves field-by-field rather than relying on a deep merge that
    // loadConfig's shallow spread doesn't do.
    expect(DEFAULT_CONFIG.compaction).toBeUndefined();
  });

  it("DEFAULT_* consts hold the FRI-156 code defaults", () => {
    expect(DEFAULT_AUTO_COMPACT_WINDOW).toEqual({
      orchestrator: 200_000,
      helper: 200_000,
      builder: 200_000,
      scheduled: 200_000,
      bare: 200_000,
      planner: 200_000,
    });
    expect(DEFAULT_COMPACTION_SWEEP).toEqual({
      sweepHour: 3,
      sweepMinute: 30,
      sweepThresholdTokens: 60_000,
    });
  });

  it("resolvers return code defaults when `compaction` is absent", () => {
    const cfg = loadConfig(); // no config.json → no compaction key
    expect(cfg.compaction).toBeUndefined();
    expect(compactionSweepHour(cfg)).toBe(3);
    expect(compactionSweepMinute(cfg)).toBe(30);
    expect(compactionSweepThreshold(cfg)).toBe(60_000);
    expect(autoCompactWindowFor(cfg, "orchestrator")).toBe(200_000);
    expect(autoCompactWindowFor(cfg, "builder")).toBe(200_000);
  });

  it("shallow-merge sibling-drop: a user `{ compaction: { sweepHour: 5 } }` keeps sibling defaults via the per-field resolvers", () => {
    // THE bug the resolvers exist to prevent (decisions.md CONFIG SHALLOW-MERGE
    // DROP): loadConfig does `{...DEFAULT_CONFIG, ...parsed}`, and since
    // DEFAULT_CONFIG.compaction is absent, the user object lands verbatim with
    // only sweepHour set. Reading sweepMinute/threshold straight off cfg would
    // be undefined; the resolvers backfill from the code defaults.
    writeFileSync(CONFIG_PATH, JSON.stringify({ compaction: { sweepHour: 5 } }) + "\n");
    const cfg = loadConfig();
    // The raw object reflects the shallow drop...
    expect(cfg.compaction).toEqual({ sweepHour: 5 });
    expect(cfg.compaction?.sweepMinute).toBeUndefined();
    // ...but the resolvers backfill the siblings from code defaults.
    expect(compactionSweepHour(cfg)).toBe(5); // overridden
    expect(compactionSweepMinute(cfg)).toBe(30); // backfilled default
    expect(compactionSweepThreshold(cfg)).toBe(60_000); // backfilled default
  });

  it("autoCompactWindowFor backfills per-type defaults under a partial override", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ compaction: { autoCompactWindow: { orchestrator: 500_000 } } }) + "\n",
    );
    const cfg = loadConfig();
    expect(autoCompactWindowFor(cfg, "orchestrator")).toBe(500_000); // overridden type
    expect(autoCompactWindowFor(cfg, "helper")).toBe(200_000); // unset type → default
    expect(autoCompactWindowFor(cfg, "builder")).toBe(200_000);
    expect(autoCompactWindowFor(cfg, "scheduled")).toBe(200_000);
    expect(autoCompactWindowFor(cfg, "bare")).toBe(200_000);
  });

  it("a full `{ compaction: {...} }` override loads each field verbatim", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        compaction: { sweepHour: 1, sweepMinute: 15, sweepThresholdTokens: 80_000 },
      }) + "\n",
    );
    const cfg = loadConfig();
    expect(compactionSweepHour(cfg)).toBe(1);
    expect(compactionSweepMinute(cfg)).toBe(15);
    expect(compactionSweepThreshold(cfg)).toBe(80_000);
  });

  it("clamps hostile/buggy config values rather than driving pathological behavior", () => {
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify({
        compaction: {
          sweepHour: 25, // out of [0,23] → clamped to 23
          sweepMinute: -1, // out of [0,59] → clamped to 0
          sweepThresholdTokens: 0, // floored at 10_000 (no sweep-everything)
          autoCompactWindow: { orchestrator: 1 }, // floored at 10_000 (no constant-compaction loop)
        },
      }) + "\n",
    );
    const cfg = loadConfig();
    expect(compactionSweepHour(cfg)).toBe(23);
    expect(compactionSweepMinute(cfg)).toBe(0);
    expect(compactionSweepThreshold(cfg)).toBe(10_000);
    expect(autoCompactWindowFor(cfg, "orchestrator")).toBe(10_000);
    // Unset type still backfills its default (clamp doesn't disturb the fallback).
    expect(autoCompactWindowFor(cfg, "helper")).toBe(200_000);
  });
});
