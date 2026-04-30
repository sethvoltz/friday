import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-evolve-${process.pid}-${Date.now()}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

const {
  saveProposal,
  getProposal,
  updateProposal,
  deleteProposal,
  listProposals,
  findProposalBySignalHash,
  parseProposal,
  serializeProposal,
  ensureImprovementsDirs,
} = await import("./store.js");

const baseSignal = {
  hash: "abcd1234",
  source: "daemon" as const,
  key: "agent_health_crashed",
  severity: "high" as const,
  count: 3,
  firstSeenAt: "2026-04-26T00:00:00.000Z",
  lastSeenAt: "2026-04-26T01:00:00.000Z",
  agent: "builder-foo",
  evidencePointers: [{ kind: "daemon" as const, path: "/tmp/daemon.jsonl", line: 12 }],
};

describe("improvements store", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    ensureImprovementsDirs();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves and retrieves a proposal", () => {
    const p = saveProposal({
      title: "Crash repeating on builder-foo",
      type: "memory",
      proposedChange: "Body content here",
      signals: [baseSignal],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "scheduled-meta-daily",
      score: 85,
      status: "critical",
    });

    expect(p.id).toBeTruthy();
    expect(p.status).toBe("critical");

    const fetched = getProposal(p.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Crash repeating on builder-foo");
    expect(fetched!.signals[0].hash).toBe("abcd1234");
    expect(fetched!.signals[0].evidencePointers[0].line).toBe(12);
  });

  it("returns null for missing proposal", () => {
    expect(getProposal("nope")).toBeNull();
  });

  it("updates and deletes proposals", () => {
    const p = saveProposal({
      title: "x",
      type: "memory",
      proposedChange: "y",
      signals: [baseSignal],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    const updated = updateProposal(p.id, { score: 50, status: "open" });
    expect(updated!.score).toBe(50);
    expect(Date.parse(updated!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(p.updatedAt));

    expect(deleteProposal(p.id)).toBe(true);
    expect(deleteProposal(p.id)).toBe(false);
  });

  it("roundtrips through serialize/parse including signal payload", () => {
    const p = saveProposal({
      title: 'Quoted "title"',
      type: "memory",
      proposedChange: "Body line 1\nBody line 2",
      signals: [baseSignal, { ...baseSignal, hash: "ffff0000", count: 1 }],
      blastRadius: "medium",
      appliesTo: ["agent.systemPrompt"],
      createdBy: "cli",
    });

    const raw = serializeProposal(p);
    const reparsed = parseProposal(p.id, raw);

    expect(reparsed.title).toBe('Quoted "title"');
    expect(reparsed.proposedChange).toBe("Body line 1\nBody line 2");
    expect(reparsed.signals).toHaveLength(2);
    expect(reparsed.signals[0].evidencePointers[0].line).toBe(12);
    expect(reparsed.appliesTo).toEqual(["agent.systemPrompt"]);
  });

  it("lists all proposals", () => {
    saveProposal({
      title: "A",
      type: "memory",
      proposedChange: "a",
      signals: [baseSignal],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });
    saveProposal({
      title: "B",
      type: "memory",
      proposedChange: "b",
      signals: [{ ...baseSignal, hash: "1111aaaa" }],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    const all = listProposals();
    expect(all).toHaveLength(2);
  });

  it("roundtrips lastEnrichError and lastEnrichFailedAt", () => {
    const p = saveProposal({
      title: "error fields",
      type: "memory",
      proposedChange: "stub",
      signals: [baseSignal],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
    });

    expect(p.lastEnrichError).toBeNull();
    expect(p.lastEnrichFailedAt).toBeNull();

    const errMsg = 'enrichment aborted (SIGINT or parent session lifecycle)';
    const now = new Date().toISOString();
    const withError = updateProposal(p.id, { lastEnrichError: errMsg, lastEnrichFailedAt: now });
    expect(withError?.lastEnrichError).toBe(errMsg);
    expect(withError?.lastEnrichFailedAt).toBe(now);

    // Verify it survives a serialize/parse round-trip.
    const fetched = getProposal(p.id);
    expect(fetched?.lastEnrichError).toBe(errMsg);
    expect(fetched?.lastEnrichFailedAt).toBe(now);

    // Clearing works.
    const cleared = updateProposal(p.id, { lastEnrichError: null, lastEnrichFailedAt: null });
    expect(cleared?.lastEnrichError).toBeNull();
    expect(cleared?.lastEnrichFailedAt).toBeNull();
  });

  it("finds an open proposal by signal hash", () => {
    const p = saveProposal({
      title: "open one",
      type: "memory",
      proposedChange: "x",
      signals: [baseSignal],
      blastRadius: "low",
      appliesTo: [],
      createdBy: "cli",
      status: "open",
    });

    const found = findProposalBySignalHash(baseSignal.hash);
    expect(found?.id).toBe(p.id);

    updateProposal(p.id, { status: "rejected" });
    expect(findProposalBySignalHash(baseSignal.hash)).toBeNull();
  });
});
