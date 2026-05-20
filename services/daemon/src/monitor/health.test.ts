/**
 * `health.json`'s `port` field is the source of truth that `friday
 * status` reads to display the daemon's actually-bound port. Without it,
 * status falls back to `cfg.daemonPort ?? PROD_DAEMON_PORT` and surfaces
 * "(config — not heartbeating)." This test pins the payload shape so a
 * future refactor that drops the field would fail loudly.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "friday-health-test-"));
process.env.FRIDAY_DATA_DIR = root;

const { HEALTH_PATH } = await import("@friday/shared");
const { startHealthHeartbeat, clearHealth } = await import("./health.js");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("startHealthHeartbeat", () => {
  it("writes the bound port into health.json on the first tick", () => {
    const port = 7610;
    const handle = startHealthHeartbeat(port);
    try {
      expect(existsSync(HEALTH_PATH)).toBe(true);
      const payload = JSON.parse(readFileSync(HEALTH_PATH, "utf8")) as {
        port: number;
        pid: number;
        uptimeSec: number;
        rssMb: number;
        ts: string;
      };
      expect(payload.port).toBe(port);
      expect(payload.pid).toBe(process.pid);
      expect(typeof payload.ts).toBe("string");
      expect(typeof payload.uptimeSec).toBe("number");
      expect(typeof payload.rssMb).toBe("number");
    } finally {
      clearInterval(handle);
      clearHealth();
    }
  });

  it("propagates a different port without ambiguity", () => {
    const port = 7444; // dev daemon port — the wrapper would set this via FRIDAY_DAEMON_PORT
    const handle = startHealthHeartbeat(port);
    try {
      const payload = JSON.parse(readFileSync(HEALTH_PATH, "utf8")) as {
        port: number;
      };
      expect(payload.port).toBe(port);
    } finally {
      clearInterval(handle);
      clearHealth();
    }
  });
});
