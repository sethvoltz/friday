/**
 * `friday status` reads the daemon's actually-bound port from
 * `health.json`'s `port` field and falls back to config when the
 * heartbeat is missing or stale. These tests pin the three cases the
 * status command must distinguish so the operator can tell "daemon
 * down" from "daemon up but old build (no port in heartbeat)" from
 * "daemon up and probed" at a glance.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const root = mkdtempSync(join(tmpdir(), "friday-status-test-"));
process.env.FRIDAY_DATA_DIR = root;

const { HEALTH_PATH } = await import("@friday/shared");
const { readHealth, probeDashboard } = await import("./status.js");

afterEach(() => {
  if (existsSync(HEALTH_PATH)) unlinkSync(HEALTH_PATH);
});

describe("readHealth", () => {
  it("returns present=false when health.json is missing", () => {
    const snap = readHealth();
    expect(snap.present).toBe(false);
    expect(snap.port).toBeUndefined();
    expect(snap.stale).toBe(false);
  });

  it("returns the port when a fresh health.json carries it", () => {
    const payload = {
      ts: new Date().toISOString(),
      pid: 12345,
      port: 7610,
      uptimeSec: 42,
      rssMb: 128,
    };
    writeFileSync(HEALTH_PATH, JSON.stringify(payload));
    const snap = readHealth();
    expect(snap.present).toBe(true);
    expect(snap.stale).toBe(false);
    expect(snap.port).toBe(7610);
    expect(snap.pid).toBe(12345);
    expect(snap.uptimeSec).toBe(42);
  });

  it("flags stale=true when mtime is older than 60s", () => {
    const payload = {
      ts: new Date().toISOString(),
      pid: 12345,
      port: 7610,
      uptimeSec: 42,
      rssMb: 128,
    };
    writeFileSync(HEALTH_PATH, JSON.stringify(payload));
    // Force mtime two minutes in the past.
    const twoMinutesAgo = (Date.now() - 120_000) / 1000;
    utimesSync(HEALTH_PATH, twoMinutesAgo, twoMinutesAgo);
    const snap = readHealth();
    expect(snap.present).toBe(true);
    expect(snap.stale).toBe(true);
    expect(snap.port).toBe(7610); // still readable, just flagged stale
  });

  it("handles a heartbeat written before the port field was added (port undefined)", () => {
    // Pre-2026-05-20 daemons wrote {ts, pid, uptimeSec, rssMb} only.
    const legacy = {
      ts: new Date().toISOString(),
      pid: 12345,
      uptimeSec: 42,
      rssMb: 128,
    };
    writeFileSync(HEALTH_PATH, JSON.stringify(legacy));
    const snap = readHealth();
    expect(snap.present).toBe(true);
    expect(snap.stale).toBe(false);
    expect(snap.port).toBeUndefined(); // status falls back to cfg/PROD constant
    expect(snap.pid).toBe(12345);
  });

  it("survives malformed JSON without throwing", () => {
    writeFileSync(HEALTH_PATH, "not json {{{");
    const snap = readHealth();
    expect(snap.present).toBe(false);
  });
});

describe("probeDashboard", () => {
  let server: Server | null = null;

  function startServerOn(handler: (status: number) => number): Promise<number> {
    return new Promise((resolve) => {
      server = createServer((_req, res) => {
        const status = handler(0);
        res.statusCode = status;
        res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        if (typeof addr === "object" && addr !== null) {
          resolve(addr.port);
        }
      });
    });
  }

  async function stopServer(): Promise<void> {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  }

  it("returns the response status when the server answers in time", async () => {
    const port = await startServerOn(() => 200);
    try {
      const status = await probeDashboard(port, 1000);
      expect(status).toBe(200);
    } finally {
      await stopServer();
    }
  });

  it("surfaces 4xx redirects (e.g. /login) as a non-null reachable signal", async () => {
    const port = await startServerOn(() => 302);
    try {
      const status = await probeDashboard(port, 1000);
      expect(status).toBe(302);
    } finally {
      await stopServer();
    }
  });

  it("returns null when the port is closed (connection refused)", async () => {
    // A high random port unlikely to be bound. We don't bind anything.
    const status = await probeDashboard(59999, 500);
    expect(status).toBeNull();
  });

  it("returns null on timeout", async () => {
    const slow = createServer((_req, res) => {
      // Never answer — let the AbortController fire.
      setTimeout(() => res.end(), 5000);
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", () => resolve()));
    const addr = slow.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      const t0 = Date.now();
      const status = await probeDashboard(port, 100);
      const elapsed = Date.now() - t0;
      expect(status).toBeNull();
      expect(elapsed).toBeLessThan(1000); // proves the abort actually fired
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });
});
