import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanDaemonLog, signalHash } from "./scan.js";

let workDir: string;
let logPath: string;

function writeLog(lines: object[]): void {
  writeFileSync(logPath, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
}

describe("scanDaemonLog", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "friday-evolve-scan-"));
    logPath = join(workDir, "daemon.jsonl");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns empty array when log is missing", () => {
    expect(scanDaemonLog({ daemonLogPath: join(workDir, "missing.jsonl") })).toEqual([]);
  });

  it("buckets repeated events into a single signal with correct count", () => {
    writeLog([
      { ts: "2026-04-26T00:00:00.000Z", level: "warn", event: "agent_health_crashed", agent: "builder-foo" },
      { ts: "2026-04-26T00:01:00.000Z", level: "warn", event: "agent_health_crashed", agent: "builder-foo" },
      { ts: "2026-04-26T00:02:00.000Z", level: "warn", event: "agent_health_crashed", agent: "builder-foo" },
    ]);

    const signals = scanDaemonLog({ daemonLogPath: logPath });
    expect(signals).toHaveLength(1);
    expect(signals[0].count).toBe(3);
    expect(signals[0].severity).toBe("high");
    expect(signals[0].agent).toBe("builder-foo");
    expect(signals[0].key).toBe("agent_health_crashed");
    expect(signals[0].hash).toBe(signalHash("agent_health_crashed", "builder-foo"));
  });

  it("treats different agents as distinct signals", () => {
    writeLog([
      { ts: "2026-04-26T00:00:00.000Z", event: "agent_loop_error", agent: "builder-foo" },
      { ts: "2026-04-26T00:00:01.000Z", event: "agent_loop_error", agent: "builder-bar" },
    ]);

    const signals = scanDaemonLog({ daemonLogPath: logPath });
    expect(signals).toHaveLength(2);
  });

  it("ignores events outside the since window", () => {
    writeLog([
      { ts: "2026-04-25T00:00:00.000Z", event: "agent_health_crashed", agent: "x" },
      { ts: "2026-04-26T00:00:00.000Z", event: "agent_health_crashed", agent: "x" },
    ]);

    const signals = scanDaemonLog({
      daemonLogPath: logPath,
      since: "2026-04-25T12:00:00.000Z",
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].count).toBe(1);
  });

  it("ignores events without a known severity mapping", () => {
    writeLog([
      { ts: "2026-04-26T00:00:00.000Z", event: "config_loaded" },
      { ts: "2026-04-26T00:00:01.000Z", event: "agent_registered", name: "x" },
    ]);

    expect(scanDaemonLog({ daemonLogPath: logPath })).toEqual([]);
  });

  it("excludes events whose agent is the meta-agent itself (no self-feedback loop)", () => {
    writeLog([
      { ts: "2026-04-26T00:00:00.000Z", event: "scheduled_run_failed", agent: "scheduled-meta-daily" },
      { ts: "2026-04-26T00:00:01.000Z", event: "scheduled_run_failed", agent: "scheduled-meta-weekly" },
      { ts: "2026-04-26T00:00:02.000Z", event: "scheduled_run_failed", agent: "scheduled-other" },
    ]);

    const signals = scanDaemonLog({ daemonLogPath: logPath });
    expect(signals).toHaveLength(1);
    expect(signals[0].agent).toBe("scheduled-other");
  });

  it("survives a malformed line in the middle of the log", () => {
    writeFileSync(
      logPath,
      [
        JSON.stringify({ ts: "2026-04-26T00:00:00.000Z", event: "agent_loop_error", agent: "x" }),
        "{not json",
        JSON.stringify({ ts: "2026-04-26T00:00:01.000Z", event: "agent_loop_error", agent: "x" }),
      ].join("\n") + "\n"
    );

    const signals = scanDaemonLog({ daemonLogPath: logPath });
    expect(signals).toHaveLength(1);
    expect(signals[0].count).toBe(2);
  });

  it("caps evidencePointers at three", () => {
    writeLog(
      Array.from({ length: 10 }, (_, i) => ({
        ts: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
        event: "agent_loop_error",
        agent: "x",
      }))
    );

    const [signal] = scanDaemonLog({ daemonLogPath: logPath });
    expect(signal.count).toBe(10);
    expect(signal.evidencePointers).toHaveLength(3);
  });
});
