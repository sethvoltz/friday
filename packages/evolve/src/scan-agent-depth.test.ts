/**
 * ADR-022 / FRI-102 — depth-scanner unit tests (AC #14, #15, #31, #32).
 *
 * The scanner reads daemon.jsonl and emits a single
 * `agent.spawn.deep-nesting` signal when more than
 * AGENT_DEPTH_COUNT_THRESHOLD `agent.spawn` events at
 * `depth >= AGENT_DEPTH_THRESHOLD` are observed in the rolling window.
 * Strictly greater-than: exactly the threshold count stays silent.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_DEPTH_COUNT_THRESHOLD,
  AGENT_DEPTH_SIGNAL_KEY,
  AGENT_DEPTH_THRESHOLD,
  AGENT_DEPTH_WINDOW_HOURS,
  scanAgentSpawnDepth,
} from "./scan-agent-depth.js";

let tmp: string;
let logPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scan-agent-depth-"));
  logPath = join(tmp, "daemon.jsonl");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeLog(events: Array<Record<string, unknown>>): void {
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(logPath, lines + "\n", "utf-8");
}

function spawnEvent(opts: {
  ts: string;
  depth: number;
  child?: string;
  parent?: string;
}): Record<string, unknown> {
  return {
    ts: opts.ts,
    level: "info",
    event: "agent.spawn",
    parent: opts.parent ?? "builder-A",
    child: opts.child ?? `helper-${opts.depth}`,
    type: "helper",
    depth: opts.depth,
    parentChain: [],
    reason: "test",
  };
}

describe("scanAgentSpawnDepth — thresholds (AC #14, #31, #32)", () => {
  it("emits zero signals when log file does not exist", () => {
    expect(scanAgentSpawnDepth({ daemonLogPath: logPath })).toEqual([]);
  });

  it("emits zero signals when threshold count is matched (strictly greater-than)", () => {
    const ts = "2026-05-21T00:00:00.000Z";
    // Exactly AGENT_DEPTH_COUNT_THRESHOLD events at depth >= threshold.
    const events = Array.from({ length: AGENT_DEPTH_COUNT_THRESHOLD }, () =>
      spawnEvent({ ts, depth: AGENT_DEPTH_THRESHOLD }),
    );
    writeLog(events);
    const now = new Date(Date.parse(ts) + 60_000);
    expect(scanAgentSpawnDepth({ daemonLogPath: logPath, now })).toEqual([]);
  });

  it("emits exactly one signal when count exceeds threshold", () => {
    const ts = "2026-05-21T00:00:00.000Z";
    const events = Array.from({ length: AGENT_DEPTH_COUNT_THRESHOLD + 1 }, () =>
      spawnEvent({ ts, depth: AGENT_DEPTH_THRESHOLD }),
    );
    writeLog(events);
    const now = new Date(Date.parse(ts) + 60_000);
    const signals = scanAgentSpawnDepth({ daemonLogPath: logPath, now });
    expect(signals).toHaveLength(1);
    expect(signals[0].count).toBe(AGENT_DEPTH_COUNT_THRESHOLD + 1);
  });

  it("ignores spawns below the depth threshold even if numerous", () => {
    const ts = "2026-05-21T00:00:00.000Z";
    const events = Array.from({ length: 50 }, () =>
      spawnEvent({ ts, depth: AGENT_DEPTH_THRESHOLD - 1 }),
    );
    writeLog(events);
    const now = new Date(Date.parse(ts) + 60_000);
    expect(scanAgentSpawnDepth({ daemonLogPath: logPath, now })).toEqual([]);
  });

  it("ignores spawns outside the rolling window", () => {
    const stale = "2026-04-01T00:00:00.000Z"; // > 24h before `now`
    const events = Array.from({ length: 20 }, () =>
      spawnEvent({ ts: stale, depth: AGENT_DEPTH_THRESHOLD + 1 }),
    );
    writeLog(events);
    const now = new Date("2026-05-21T00:00:00.000Z");
    expect(
      scanAgentSpawnDepth({
        daemonLogPath: logPath,
        windowHours: AGENT_DEPTH_WINDOW_HOURS,
        now,
      }),
    ).toEqual([]);
  });
});

describe("scanAgentSpawnDepth — signal shape (AC #15)", () => {
  it("returned signal matches the Signal shape with hash/firstSeenAt/lastSeenAt/evidencePointers", () => {
    const t0 = "2026-05-21T01:00:00.000Z";
    const t1 = "2026-05-21T02:00:00.000Z";
    const t2 = "2026-05-21T03:00:00.000Z";
    const events = [
      spawnEvent({ ts: t0, depth: AGENT_DEPTH_THRESHOLD }),
      spawnEvent({ ts: t1, depth: AGENT_DEPTH_THRESHOLD }),
      spawnEvent({ ts: t2, depth: AGENT_DEPTH_THRESHOLD }),
      spawnEvent({ ts: t2, depth: AGENT_DEPTH_THRESHOLD }),
      spawnEvent({ ts: t2, depth: AGENT_DEPTH_THRESHOLD }),
      spawnEvent({ ts: t2, depth: AGENT_DEPTH_THRESHOLD }),
    ];
    writeLog(events);
    const now = new Date(Date.parse(t2) + 60_000);
    const [signal] = scanAgentSpawnDepth({ daemonLogPath: logPath, now });
    expect(signal).toMatchObject({
      hash: expect.any(String),
      source: "daemon",
      key: AGENT_DEPTH_SIGNAL_KEY,
      severity: "low",
      count: 6,
      firstSeenAt: t0,
      lastSeenAt: t2,
      evidencePointers: expect.arrayContaining([
        expect.objectContaining({
          kind: "daemon",
          path: logPath,
          line: expect.any(Number),
        }),
      ]),
    });
  });
});

describe("scanAgentSpawnDepth — robustness", () => {
  it("skips lines that aren't agent.spawn", () => {
    const ts = "2026-05-21T01:00:00.000Z";
    const events: Array<Record<string, unknown>> = [
      { ts, event: "worker.fork", agent: "builder-A" },
      { ts, event: "watchdog.refork", agent: "builder-A" },
      ...Array.from({ length: AGENT_DEPTH_COUNT_THRESHOLD + 1 }, () =>
        spawnEvent({ ts, depth: AGENT_DEPTH_THRESHOLD }),
      ),
    ];
    writeLog(events);
    const now = new Date(Date.parse(ts) + 60_000);
    const signals = scanAgentSpawnDepth({ daemonLogPath: logPath, now });
    expect(signals).toHaveLength(1);
    expect(signals[0].count).toBe(AGENT_DEPTH_COUNT_THRESHOLD + 1);
  });

  it("skips malformed JSON lines without crashing", () => {
    const ts = "2026-05-21T01:00:00.000Z";
    const lines = [
      "{not-json",
      JSON.stringify(spawnEvent({ ts, depth: AGENT_DEPTH_THRESHOLD })),
      "",
      JSON.stringify(spawnEvent({ ts, depth: AGENT_DEPTH_THRESHOLD })),
    ];
    writeFileSync(logPath, lines.join("\n"), "utf-8");
    const now = new Date(Date.parse(ts) + 60_000);
    // Only 2 valid matches, below threshold → no signal.
    expect(scanAgentSpawnDepth({ daemonLogPath: logPath, now })).toEqual([]);
  });

  it("ignores entries missing a numeric depth field", () => {
    const ts = "2026-05-21T01:00:00.000Z";
    const events: Array<Record<string, unknown>> = [
      ...Array.from({ length: AGENT_DEPTH_COUNT_THRESHOLD + 1 }, () => ({
        ts,
        event: "agent.spawn",
        parent: "builder-A",
        child: "helper-x",
        type: "helper",
        depth: "not-a-number",
        parentChain: [],
        reason: "test",
      })),
    ];
    writeLog(events);
    const now = new Date(Date.parse(ts) + 60_000);
    expect(scanAgentSpawnDepth({ daemonLogPath: logPath, now })).toEqual([]);
  });
});
