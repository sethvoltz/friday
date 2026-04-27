import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-evolve-propose-${process.pid}-${Date.now()}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

const { scanDaemonLog } = await import("./scan.js");
const { proposeFromSignals, rerankAll } = await import("./propose.js");
const { listProposals, ensureImprovementsDirs } = await import("./store.js");

const RULE = { criticalScore: 80, criticalFrequency: 5 };

describe("proposeFromSignals (integration with scan)", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    ensureImprovementsDirs();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates one proposal per distinct signal hash", () => {
    const logPath = join(testDir, "daemon.jsonl");
    writeFileSync(
      logPath,
      [
        { ts: "2026-04-26T00:00:00.000Z", event: "agent_health_crashed", agent: "builder-foo" },
        { ts: "2026-04-26T00:01:00.000Z", event: "agent_health_crashed", agent: "builder-foo" },
        { ts: "2026-04-26T00:02:00.000Z", event: "mail_poller_error" },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n") + "\n"
    );

    const signals = scanDaemonLog({ daemonLogPath: logPath });
    const result = proposeFromSignals(signals, { rule: RULE, createdBy: "scheduled-meta-daily" });

    expect(result.created).toHaveLength(2);
    expect(listProposals()).toHaveLength(2);
  });

  it("merges new occurrences into an existing open proposal rather than duplicating", () => {
    const logPath = join(testDir, "daemon.jsonl");
    writeFileSync(
      logPath,
      JSON.stringify({ ts: "2026-04-26T00:00:00.000Z", event: "agent_loop_error", agent: "x" }) + "\n"
    );

    const first = proposeFromSignals(scanDaemonLog({ daemonLogPath: logPath }), {
      rule: RULE,
      createdBy: "cli",
    });
    expect(first.created).toHaveLength(1);

    // Second pass: more of the same event.
    writeFileSync(
      logPath,
      [
        { ts: "2026-04-26T00:00:00.000Z", event: "agent_loop_error", agent: "x" },
        { ts: "2026-04-26T00:01:00.000Z", event: "agent_loop_error", agent: "x" },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n") + "\n"
    );
    const second = proposeFromSignals(scanDaemonLog({ daemonLogPath: logPath }), {
      rule: RULE,
      createdBy: "cli",
    });

    expect(second.created).toHaveLength(0);
    expect(second.updated).toHaveLength(1);
    expect(listProposals()).toHaveLength(1);
    expect(listProposals()[0].signals[0].count).toBe(2);
  });

  it("promotes a proposal to critical when score and frequency cross thresholds", () => {
    const logPath = join(testDir, "daemon.jsonl");
    const lines = Array.from({ length: 30 }, (_, i) => ({
      ts: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
      event: "agent_health_crashed",
      agent: "builder-foo",
    }));
    writeFileSync(logPath, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");

    const signals = scanDaemonLog({ daemonLogPath: logPath });
    const result = proposeFromSignals(signals, { rule: RULE, createdBy: "cli" });

    expect(result.created).toHaveLength(1);
    expect(result.promotedToCritical).toHaveLength(1);
    expect(result.created[0].status).toBe("critical");
  });

  it("rerankAll does nothing when scores are unchanged", () => {
    const logPath = join(testDir, "daemon.jsonl");
    writeFileSync(
      logPath,
      JSON.stringify({ ts: "2026-04-26T00:00:00.000Z", event: "agent_loop_error", agent: "x" }) + "\n"
    );
    proposeFromSignals(scanDaemonLog({ daemonLogPath: logPath }), {
      rule: RULE,
      createdBy: "cli",
    });

    const result = rerankAll(RULE);
    expect(result.reranked).toHaveLength(0);
    expect(result.promoted).toHaveLength(0);
  });
});
