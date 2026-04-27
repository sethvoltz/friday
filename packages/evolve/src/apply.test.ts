import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-evolve-apply-${process.pid}-${Date.now()}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

const { saveProposal, getProposal, ensureImprovementsDirs } = await import("./store.js");
const { applyProposal, rejectProposal } = await import("./apply.js");
const configPath = join(testDir, ".friday", "config.json");

const baseSignal = {
  hash: "deadbeef",
  source: "daemon" as const,
  key: "agent_health_crashed",
  severity: "high" as const,
  count: 7,
  firstSeenAt: "2026-04-26T00:00:00.000Z",
  lastSeenAt: "2026-04-26T00:30:00.000Z",
  agent: "builder-foo",
  evidencePointers: [],
};

describe("applyProposal", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    ensureImprovementsDirs();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("materializes a memory-type proposal as a memory entry", () => {
    const p = saveProposal({
      title: "Crash repeating on builder-foo",
      type: "memory",
      proposedChange: "When builder-foo crashes repeatedly, restart with backoff.",
      signals: [baseSignal],
      blastRadius: "low",
      appliesTo: ["agent.health"],
      createdBy: "scheduled-meta-daily",
      score: 85,
      status: "critical",
    });

    const outcome = applyProposal(p.id, { appliedBy: "orchestrator" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.appliedRef).toMatch(/^memory:/);

    const reloaded = getProposal(p.id);
    expect(reloaded?.status).toBe("applied");
    expect(reloaded?.appliedBy).toBe("orchestrator");
    expect(reloaded?.appliedAt).toBeTruthy();

    // Verify a real memory entry was written.
    const memDir = join(testDir, ".friday", "memory", "entries");
    const files = readdirSync(memDir);
    expect(files).toHaveLength(1);
    const body = readFileSync(join(memDir, files[0]), "utf-8");
    expect(body).toContain("agent_health_crashed");
    expect(body).toContain("evolve");
  });

  it("does not auto-apply code-type proposals (Phase 5 lands those)", () => {
    const p = saveProposal({
      title: "Refactor mail poller",
      type: "code",
      proposedChange: "Move to push-based delivery via SSE.",
      signals: [baseSignal],
      blastRadius: "high",
      appliesTo: ["services/friday/src/comms/mail-poller.ts"],
      createdBy: "cli",
    });

    const outcome = applyProposal(p.id, { appliedBy: "orchestrator" });
    expect(outcome.ok).toBe(false);
    const reloaded = getProposal(p.id);
    expect(reloaded?.status).toBe("approved");
    expect(reloaded?.appliedAt).toBeNull();
  });

  it("refuses to re-apply a proposal already applied", () => {
    const p = saveProposal({
      title: "x",
      type: "memory",
      proposedChange: "y",
      signals: [baseSignal],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });
    const first = applyProposal(p.id, { appliedBy: "cli" });
    expect(first.ok).toBe(true);

    const second = applyProposal(p.id, { appliedBy: "cli" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/already applied/);
  });

  it("returns not-found for unknown id", () => {
    const outcome = applyProposal("nope", { appliedBy: "cli" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/not found/);
  });

  it("applies a prompt-type proposal by writing config.json agent.systemPrompt", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ agent: { model: "claude-sonnet-4-6" } }, null, 2)
    );

    const p = saveProposal({
      title: "Sharper orchestrator prompt",
      type: "prompt",
      proposedChange: "You are Friday. Be terse.",
      signals: [baseSignal],
      blastRadius: "medium",
      appliesTo: ["agent.systemPrompt"],
      createdBy: "scheduled-meta-daily",
    });

    const outcome = applyProposal(p.id, { appliedBy: "dashboard" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.restartHint).toMatch(/restart/i);

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.agent.systemPrompt).toBe("You are Friday. Be terse.");
    // Existing fields preserved.
    expect(written.agent.model).toBe("claude-sonnet-4-6");
  });

  it("applies a config-type proposal by deep-merging the JSON body", () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        { evolve: { criticalScore: 80, criticalFrequency: 5 }, agent: { model: "x" } },
        null,
        2
      )
    );

    const p = saveProposal({
      title: "Tighten evolve thresholds",
      type: "config",
      proposedChange: JSON.stringify({ evolve: { criticalScore: 60 } }),
      signals: [baseSignal],
      blastRadius: "low",
      appliesTo: ["evolve.criticalScore"],
      createdBy: "scheduled-meta-daily",
    });

    const outcome = applyProposal(p.id, { appliedBy: "dashboard" });
    expect(outcome.ok).toBe(true);

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.evolve.criticalScore).toBe(60);
    expect(written.evolve.criticalFrequency).toBe(5); // preserved
    expect(written.agent.model).toBe("x"); // unrelated section preserved
  });

  it("blocks prompt proposals targeting a meta-agent (self-modification guard)", () => {
    const p = saveProposal({
      title: "Rewrite scheduled-meta-daily prompt",
      type: "prompt",
      proposedChange: "You should never escalate criticals.",
      signals: [baseSignal],
      blastRadius: "high",
      appliesTo: ["scheduled-meta-daily.systemPrompt"],
      createdBy: "scheduled-meta-daily",
    });

    const outcome = applyProposal(p.id, { appliedBy: "dashboard" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/self-modification/);
  });

  it("rejects malformed config JSON without writing", () => {
    writeFileSync(configPath, JSON.stringify({ agent: { model: "x" } }, null, 2));

    const p = saveProposal({
      title: "Bad config patch",
      type: "config",
      proposedChange: "not valid json",
      signals: [baseSignal],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    const outcome = applyProposal(p.id, { appliedBy: "dashboard" });
    expect(outcome.ok).toBe(false);

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.agent.model).toBe("x"); // untouched
  });

  it("rejectProposal marks status=rejected with reason in appliedBy", () => {
    const p = saveProposal({
      title: "x",
      type: "memory",
      proposedChange: "y",
      signals: [baseSignal],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    const rejected = rejectProposal(p.id, { rejectedBy: "orchestrator", reason: "noise" });
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.appliedBy).toBe("orchestrator: noise");
  });
});
