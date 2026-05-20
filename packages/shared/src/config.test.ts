/**
 * `resolveDaemonPort` / `resolveDashboardPort` are the canonical port
 * lookups that every cross-process port consumer uses (daemon's own
 * bind, dashboard's daemon-fetch URL, `friday status`'s display). The
 * env-override chain matters specifically because the dev wrappers set
 * `FRIDAY_DAEMON_PORT=7444` to redirect dev's dashboard at dev's
 * daemon — that resolution path must work without rebuilds or config
 * edits.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
