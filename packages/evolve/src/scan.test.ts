import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanDaemonLog,
  scanFeedback,
  scanUsageLog,
  scanTranscripts,
  signalHash,
} from "./scan.js";

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

describe("scanFeedback", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "friday-evolve-feedback-"));
    path = join(dir, "feedback.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing when the log is missing", () => {
    expect(scanFeedback({ feedbackLogPath: join(dir, "missing.jsonl") })).toEqual([]);
  });

  it("buckets edited and deleted into separate signals", () => {
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: "2026-04-26T00:00:00.000Z", kind: "edited", channelId: "C1", messageTs: "1" }),
        JSON.stringify({ ts: "2026-04-26T00:00:01.000Z", kind: "deleted", channelId: "C1", messageTs: "2" }),
        JSON.stringify({ ts: "2026-04-26T00:00:02.000Z", kind: "edited", channelId: "C1", messageTs: "3" }),
      ].join("\n") + "\n"
    );

    const signals = scanFeedback({ feedbackLogPath: path });
    expect(signals.map((s) => s.key).sort()).toEqual([
      "slack_deleted_processed",
      "slack_edited_processed",
    ]);
    const edited = signals.find((s) => s.key === "slack_edited_processed")!;
    expect(edited.count).toBe(2);
  });

  it("emits slack_retry_burst when the same message is edited 3+ times", () => {
    writeFileSync(
      path,
      Array.from({ length: 4 }, (_, i) =>
        JSON.stringify({
          ts: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
          kind: "edited",
          channelId: "C1",
          messageTs: "same-message",
        })
      ).join("\n") + "\n"
    );

    const signals = scanFeedback({ feedbackLogPath: path });
    const burst = signals.find((s) => s.key === "slack_retry_burst");
    expect(burst).toBeDefined();
    expect(burst!.severity).toBe("medium");
  });

  it("does not emit slack_retry_burst at fewer than 3 edits", () => {
    // Pin the boundary: 2 edits to the same message must NOT trigger burst.
    writeFileSync(
      path,
      Array.from({ length: 2 }, (_, i) =>
        JSON.stringify({
          ts: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
          kind: "edited",
          channelId: "C1",
          messageTs: "same-message",
        })
      ).join("\n") + "\n"
    );

    const signals = scanFeedback({ feedbackLogPath: path });
    expect(signals.find((s) => s.key === "slack_retry_burst")).toBeUndefined();
  });

  it("excludes feedback whose agent is the meta-agent", () => {
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: "2026-04-26T00:00:00.000Z", kind: "edited", channelId: "C1", messageTs: "1", agent: "scheduled-meta-daily" }),
        JSON.stringify({ ts: "2026-04-26T00:00:01.000Z", kind: "edited", channelId: "C1", messageTs: "2", agent: "builder-foo" }),
      ].join("\n") + "\n"
    );

    const signals = scanFeedback({ feedbackLogPath: path });
    expect(signals).toHaveLength(1);
    expect(signals[0].agent).toBe("builder-foo");
  });
});

describe("scanUsageLog", () => {
  let dir: string;
  let path: string;
  let agentsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "friday-evolve-usage-"));
    path = join(dir, "usage.jsonl");
    agentsPath = join(dir, "agents.json"); // missing — collectMetaSessions returns empty
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing when log is missing", () => {
    expect(scanUsageLog({ usageLogPath: join(dir, "missing.jsonl"), agentsPath })).toEqual([]);
  });

  it("flags a turn that exceeds the spike multiplier", () => {
    const baseline = Array.from({ length: 5 }, (_, i) => ({
      ts: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
      agent: "builder-foo",
      sessionId: "s1",
      inputTokens: 1000,
      outputTokens: 100,
    }));
    const spike = {
      ts: "2026-04-26T00:00:10.000Z",
      agent: "builder-foo",
      sessionId: "s1",
      inputTokens: 50000,
      outputTokens: 5000,
    };
    writeFileSync(path, [...baseline, spike].map((o) => JSON.stringify(o)).join("\n") + "\n");

    const signals = scanUsageLog({ usageLogPath: path, spikeMultiplier: 4, agentsPath });
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe("usage_token_spike");
    expect(signals[0].agent).toBe("builder-foo");
    expect(signals[0].severity).toBe("medium");
  });

  it("does not flag when there are too few baseline turns", () => {
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: "2026-04-26T00:00:00.000Z", agent: "x", inputTokens: 1000 }),
        JSON.stringify({ ts: "2026-04-26T00:00:01.000Z", agent: "x", inputTokens: 100000 }),
      ].join("\n") + "\n"
    );

    expect(scanUsageLog({ usageLogPath: path, agentsPath })).toEqual([]);
  });

  it("excludes meta-agent sessions by name prefix", () => {
    const baseline = Array.from({ length: 5 }, (_, i) => ({
      ts: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
      agent: "scheduled-meta-daily",
      inputTokens: 1000,
    }));
    const spike = {
      ts: "2026-04-26T00:00:10.000Z",
      agent: "scheduled-meta-daily",
      inputTokens: 999999,
    };
    writeFileSync(path, [...baseline, spike].map((o) => JSON.stringify(o)).join("\n") + "\n");

    expect(scanUsageLog({ usageLogPath: path, agentsPath })).toEqual([]);
  });

  it("excludes meta-agent sessions resolved via agents.json", () => {
    // Real-world path: a meta-agent's session id appears in usage.jsonl tagged
    // with a *different* agent name (e.g. left over from before a rename).
    // The scanner must still filter it via the agents.json session lookup.
    writeFileSync(
      agentsPath,
      JSON.stringify({
        "scheduled-meta-daily": {
          type: "scheduled",
          sessionId: "meta-session-xyz",
          status: "idle",
          createdAt: "2026-04-26T00:00:00.000Z",
          schedule: { cron: "0 4 * * *" },
          taskPrompt: "x",
          cwd: "/tmp",
          stateDir: "/tmp",
          lastRunAt: null,
          nextRunAt: null,
          paused: false,
        },
      })
    );
    const turns = Array.from({ length: 5 }, (_, i) => ({
      ts: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
      agent: "looks-innocent",
      sessionId: "meta-session-xyz",
      inputTokens: 1000,
    }));
    const spike = {
      ts: "2026-04-26T00:00:10.000Z",
      agent: "looks-innocent",
      sessionId: "meta-session-xyz",
      inputTokens: 999999,
    };
    writeFileSync(path, [...turns, spike].map((o) => JSON.stringify(o)).join("\n") + "\n");

    expect(scanUsageLog({ usageLogPath: path, agentsPath })).toEqual([]);
  });
});

describe("scanTranscripts", () => {
  let dir: string;
  let agentsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "friday-evolve-tx-"));
    agentsPath = join(dir, "agents.json"); // missing — keeps tests isolated from real registry
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing when projects root is missing", () => {
    expect(scanTranscripts({ projectsRoot: join(dir, "missing"), agentsPath })).toEqual([]);
  });

  it("detects a retry from two near-duplicate user messages within window", () => {
    const project = join(dir, "proj-a");
    mkdirSync(project, { recursive: true });
    const file = join(project, "session-abc.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-26T00:00:00.000Z",
          message: { role: "user", content: "please summarize the recent build failures" },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-26T00:01:00.000Z",
          message: { role: "user", content: "please summarize recent build failures again" },
        }),
      ].join("\n") + "\n"
    );

    const signals = scanTranscripts({ projectsRoot: dir, agentsPath });
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe("transcript_user_retry");
    expect(signals[0].evidencePointers[0].sessionId).toBe("session-abc");
  });

  it("does not flag dissimilar consecutive messages", () => {
    const project = join(dir, "proj-a");
    mkdirSync(project, { recursive: true });
    const file = join(project, "session-xyz.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-26T00:00:00.000Z",
          message: { role: "user", content: "build status please" },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-26T00:01:00.000Z",
          message: { role: "user", content: "what time is the meeting tomorrow" },
        }),
      ].join("\n") + "\n"
    );

    expect(scanTranscripts({ projectsRoot: dir, agentsPath })).toEqual([]);
  });

  it("skips transcripts whose session belongs to a meta-agent", () => {
    // Same content as the positive test, but the session id is registered
    // to scheduled-meta-daily. Must produce zero signals.
    writeFileSync(
      agentsPath,
      JSON.stringify({
        "scheduled-meta-daily": {
          type: "scheduled",
          sessionId: "session-meta",
          status: "idle",
          createdAt: "2026-04-26T00:00:00.000Z",
          schedule: { cron: "0 4 * * *" },
          taskPrompt: "x",
          cwd: "/tmp",
          stateDir: "/tmp",
          lastRunAt: null,
          nextRunAt: null,
          paused: false,
        },
      })
    );
    const project = join(dir, "proj-a");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "session-meta.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-26T00:00:00.000Z",
          message: { role: "user", content: "please summarize the recent build failures" },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-26T00:01:00.000Z",
          message: { role: "user", content: "please summarize recent build failures again" },
        }),
      ].join("\n") + "\n"
    );

    expect(scanTranscripts({ projectsRoot: dir, agentsPath })).toEqual([]);
  });
});
