import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Proposal, Signal } from "./types.js";

// ── In-memory store (propose.test.ts pattern) ───────────────────────────────
// The cycle logic (proposeFromSignals / rerankAll) is REAL and operates over
// this Map; only the IO boundary (store CRUD, scanners, runs/hygiene/diary,
// the dreaming apply) is mocked. This is the layer the bug would live in:
// run-cycle's ordering + plan-building + the post-rerank dream re-read.
const proposals = new Map<string, Proposal>();
const bySignalHash = new Map<string, string>();

function makeProposal(input: Partial<Proposal> & { title: string }): Proposal {
  const id = input.id ?? `p-${proposals.size + 1}`;
  const now = new Date().toISOString();
  return {
    id,
    title: input.title,
    type: input.type ?? "memory",
    status: input.status ?? "open",
    clusterId: null,
    score: input.score ?? 0,
    signals: input.signals ?? [],
    proposedChange: input.proposedChange ?? "",
    blastRadius: input.blastRadius ?? "low",
    appliesTo: input.appliesTo ?? [],
    createdBy: input.createdBy ?? "test",
    createdAt: now,
    updatedAt: now,
    appliedAt: input.appliedAt ?? null,
    appliedBy: input.appliedBy ?? null,
    enrichedAt: input.enrichedAt ?? null,
    enrichedBy: null,
    lastEnrichError: null,
    lastEnrichFailedAt: null,
    appliedTicketId: input.appliedTicketId ?? null,
    familyResolvedBy: input.familyResolvedBy ?? null,
    builderAgent: input.builderAgent ?? null,
    resolvedByUpgrade: false,
    tentativelyResolvedByUpgrade: false,
    resolvedByVersion: null,
    resolvedAt: null,
  } as Proposal;
}

// getProposal is mockable per-test (AC8 mutation test overrides it); default is
// the real Map read.
const getProposalImpl = vi.fn((id: string) => proposals.get(id) ?? null);

vi.mock("./store.js", () => ({
  listProposals: () => [...proposals.values()],
  getProposal: (id: string) => getProposalImpl(id),
  findProposalBySignalHash: (hash: string) => {
    const id = bySignalHash.get(hash);
    if (!id) return null;
    const p = proposals.get(id);
    if (!p) return null;
    if (p.status !== "open" && p.status !== "critical") return null;
    return p;
  },
  findRecentlyAppliedByFamilyKey: () => null,
  findRecentlyRejectedByFamilyKey: () => null,
  saveProposal: (input: Partial<Proposal> & { title: string }) => {
    const p = makeProposal(input);
    proposals.set(p.id, p);
    for (const s of p.signals) bySignalHash.set(s.hash, p.id);
    return p;
  },
  updateProposal: (id: string, updates: Partial<Proposal>) => {
    const existing = proposals.get(id);
    if (!existing) return null;
    const next = { ...existing, ...updates, updatedAt: new Date().toISOString() } as Proposal;
    proposals.set(id, next);
    for (const s of next.signals) bySignalHash.set(s.hash, id);
    return next;
  },
}));

// scanAll feeds the cycle its signals. friction/preference/dreaming scanners are
// mocked to [] (the soft-`.catch` path is exercised by the real cycle, but the
// fixtures drive everything through scanAll).
const scanAllImpl = vi.fn(async (): Promise<Signal[]> => []);
vi.mock("./scan.js", () => ({ scanAll: (...a: unknown[]) => scanAllImpl(...(a as [])) }));
vi.mock("./scan-friction.js", () => ({ scanFriction: async () => [] as Signal[] }));
vi.mock("./scan-preferences.js", () => ({ scanPreferences: async () => [] as Signal[] }));

// scan-dreaming: keep the REAL encode/decode (propose.ts depends on
// decodeDreamPayload to recognize a dream signal), mock only the LLM-backed
// scanDreaming → [].
vi.mock("./scan-dreaming.js", async (importActual) => {
  const actual = await importActual<typeof import("./scan-dreaming.js")>();
  return { ...actual, scanDreaming: async () => [] as Signal[] };
});

const resolveByUpgradeImpl = vi.fn(async () => ({ definitive: 0, tentative: 0 }));
vi.mock("./scan-upgrade-resolution.js", () => ({
  resolveByUpgrade: (...a: unknown[]) => resolveByUpgradeImpl(...(a as [])),
}));

const appendRunImpl = vi.fn();
vi.mock("./runs.js", () => ({ appendRun: (...a: unknown[]) => appendRunImpl(...(a as [])) }));

// The dreaming apply boundary — mocked so no real memory IO runs. AC8 reads the
// proposals it receives to prove the post-rerank re-read fed the mutated score.
const applyDreamProposalsImpl = vi.fn(async (_props: Proposal[], _caller: string) => ({
  promoted: [] as unknown[],
  reinforced: [] as unknown[],
  openBelowThreshold: [] as string[],
  failed: [] as string[],
}));
vi.mock("./dreaming-pipeline.js", () => ({
  applyDreamProposals: (...a: unknown[]) => applyDreamProposalsImpl(...(a as [Proposal[], string])),
}));

vi.mock("./hygiene.js", () => ({
  runHygiene: async () => ({ merged: [], decayCandidates: [], archived: [] }),
}));
vi.mock("./dream-diary.js", () => ({ appendDreamEntry: vi.fn() }));

const { runEvolveCycle } = await import("./run-cycle.js");
const { encodeDreamPayload } = await import("./scan-dreaming.js");

const NOW = "2026-06-23T00:00:00.000Z";

function highSignal(hash: string, count = 1): Signal {
  // A high-severity, frequent signal: scoreProposal → ~78 (>= criticalScore 60)
  // and isCritical fires on the high-severity branch.
  return {
    hash,
    source: "friction",
    key: "watchdog.stall.detected",
    severity: "high",
    count,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    agent: "friday",
    evidencePointers: [],
  };
}

// proposeFromSignals only ever drafts `type:"memory"` for non-dream signals, so
// a `type:"code"` proposal is seeded directly into the store as `open` with a
// STALE below-threshold score; rerankAll re-scores its (high-severity, frequent)
// signals above 60 and promotes it via the `reranked.promoted` surface — the
// only path that yields a critical CODE proposal for the builder escalation.
function seedOpenCodeProposal(id: string, sigHash: string): void {
  const p = makeProposal({
    id,
    title: `Code regression ${id}`,
    type: "code",
    status: "open",
    score: 59, // stale; rerankAll recomputes to ~78
    blastRadius: "low",
    signals: [highSignal(sigHash, 8)],
  });
  proposals.set(p.id, p);
  // Intentionally NOT registered in bySignalHash — the scan must not merge into
  // it, so its promotion comes purely from rerankAll (reranked.promoted).
}

function dreamHighSignal(hash: string): Signal {
  return {
    hash,
    source: "dream",
    key: `dream:promote:${hash}`,
    severity: "high",
    count: 8,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    agent: "orchestrator",
    evidencePointers: [
      encodeDreamPayload({
        title: `Memory ${hash}`,
        content: "a durable fact worth remembering",
        tags: ["topic"],
        category: "feedback",
      }),
    ],
  };
}

function noopEffects() {
  return {
    notify: vi.fn(),
    spawnTriage: vi.fn(),
    spawnBuilder: vi.fn(),
    listEntries: vi.fn(async () => []),
  };
}

beforeEach(() => {
  proposals.clear();
  bySignalHash.clear();
  getProposalImpl.mockReset();
  getProposalImpl.mockImplementation((id: string) => proposals.get(id) ?? null);
  scanAllImpl.mockReset();
  scanAllImpl.mockResolvedValue([]);
  resolveByUpgradeImpl.mockClear();
  appendRunImpl.mockClear();
  applyDreamProposalsImpl.mockClear();
  applyDreamProposalsImpl.mockResolvedValue({
    promoted: [],
    reinforced: [],
    openBelowThreshold: [],
    failed: [],
  });
});

const baseOpts = {
  since: NOW,
  dreamSince: NOW,
  callerName: "scan",
  orchestratorName: "friday",
};

describe("runEvolveCycle", () => {
  it("runEvolveCycle escalates a critical+code+high proposal to exactly one builder and fires one evolve_critical notify", async () => {
    // A type:"code" proposal with a severity:"high" signal scoring >= 60 →
    // rerankAll promotes it to status:"critical". builderEscalationPlan
    // (critical+code+high) yields exactly one request; the critical-notify fires
    // once.
    const id = "code-crit-1";
    seedOpenCodeProposal(id, "h1");
    scanAllImpl.mockResolvedValue([]);
    const effects = noopEffects();

    await runEvolveCycle({ ...baseOpts, effects });

    const promoted = proposals.get(id)!;
    expect(promoted.status).toBe("critical");
    expect(promoted.type).toBe("code");

    expect(effects.spawnBuilder).toHaveBeenCalledTimes(1);
    const builderArg = effects.spawnBuilder.mock.calls[0][0] as Array<{ name: string }>;
    expect(builderArg).toHaveLength(1);
    expect(builderArg[0]).toMatchObject({ name: `builder-${id}` });

    expect(effects.notify).toHaveBeenCalledTimes(1);
    expect(effects.notify.mock.calls[0][0]).toMatchObject({ type: "evolve_critical" });
  });

  it("a dream (type:memory) proposal never reaches status:critical and is absent from the triage/builder spawn union", async () => {
    // A dream signal whose score clears 60 — but proposeFromSignals sets
    // critical = !isDream && isCritical(...), so it stays `open` and never enters
    // the critical surface that triageSpawnPlan / builderEscalationPlan filter on.
    scanAllImpl.mockResolvedValue([dreamHighSignal("d1")]);
    const effects = noopEffects();

    await runEvolveCycle({ ...baseOpts, effects });

    const dream = [...proposals.values()].find((p) => p.signals.some((s) => s.source === "dream"));
    expect(dream).toBeDefined();
    expect(dream!.score).toBeGreaterThanOrEqual(60);
    expect(dream!.status).not.toBe("critical");
    const id = dream!.id;

    const triageReqs =
      (effects.spawnTriage.mock.calls[0]?.[0] as Array<{ name: string }> | undefined) ?? [];
    const builderReqs =
      (effects.spawnBuilder.mock.calls[0]?.[0] as Array<{ name: string }> | undefined) ?? [];
    expect(triageReqs.some((r) => r.name.includes(id))).toBe(false);
    expect(builderReqs.some((r) => r.name.includes(id))).toBe(false);
  });

  it("post-rerank dream re-read feeds the mutated score to the auto-apply gate", async () => {
    // MUTATION TEST. The in-memory propose.created copy carries a BELOW-threshold
    // score; getProposal(id) returns the persisted row whose score was bumped
    // ABOVE threshold by rerankAll. run-cycle's `getProposal(p.id) ?? p` must feed
    // the MUTATED (persisted) score into applyDreamProposals — the gate's input.
    //
    // This test FAILS if `getProposal(p.id) ?? p` is replaced with the stale `p`:
    // the captured proposal would then carry the below-threshold in-memory score.
    scanAllImpl.mockResolvedValue([dreamHighSignal("m1")]);
    const effects = noopEffects();

    // Mutate: getProposal returns the row with a high score, while the live Map
    // copy (proposeFromSignals' result `p`) is left at a low score.
    getProposalImpl.mockImplementation((id: string) => {
      const real = proposals.get(id);
      if (!real) return null;
      if (real.signals.some((s) => s.source === "dream")) {
        return { ...real, score: 99 };
      }
      return real;
    });

    await runEvolveCycle({ ...baseOpts, effects });

    expect(applyDreamProposalsImpl).toHaveBeenCalledTimes(1);
    const passed = applyDreamProposalsImpl.mock.calls[0][0] as Proposal[];
    const dreamPassed = passed.find((p) => p.signals.some((s) => s.source === "dream"));
    expect(dreamPassed).toBeDefined();
    // The gate saw the mutated (post-rerank) score, not the stale in-memory one.
    expect(dreamPassed!.score).toBe(99);
  });

  it("runEvolveCycle with no-op effects runs the scanAll → propose → resolveByUpgrade → appendRun → dream-apply spine in order", async () => {
    // All include* true (defaults), no-op effects — the CLI's exact path. Pin the
    // ordered IO boundary via invocationCallOrder, and prove the REAL
    // proposeFromSignals step ran in-spine via the created-count it feeds into
    // appendRun. (proposeFromSignals/rerankAll are deliberately NOT mocked: the
    // mocks here are file-global, and the promotion tests above NEED them real —
    // mocking ./propose.js would gut AC6/AC7/AC10. So the spine's propose step is
    // pinned by its observable output, not by a spy.)
    scanAllImpl.mockResolvedValue([highSignal("spine", 8)]);
    const effects = noopEffects();

    await runEvolveCycle({ ...baseOpts, callerName: "cli", effects });

    const scanOrder = scanAllImpl.mock.invocationCallOrder[0];
    const resolveOrder = resolveByUpgradeImpl.mock.invocationCallOrder[0];
    const appendOrder = appendRunImpl.mock.invocationCallOrder[0];
    const applyOrder = applyDreamProposalsImpl.mock.invocationCallOrder[0];

    expect(scanOrder).toBeLessThan(resolveOrder);
    expect(resolveOrder).toBeLessThan(appendOrder);
    expect(appendOrder).toBeLessThan(applyOrder);

    // proposeFromSignals (REAL) ran between scanAll and appendRun: the audit
    // record carries the created-count it produced from the scanned signal,
    // so appendRun provably executed AFTER the propose step (not on a fresh
    // empty store).
    expect(appendRunImpl).toHaveBeenCalledTimes(1);
    expect(appendRunImpl.mock.calls[0][0]).toMatchObject({ by: "cli", proposalsCreated: 1 });
  });

  it("critical-notify count math preserves promotedToCritical + reranked.promoted", async () => {
    // Two distinct critical proposals across BOTH summands of the count math:
    //   (1) propose.promotedToCritical — a fresh high-severity signal promotes on
    //       create (a `type:"memory"` proposal; isCritical ignores type), AND
    //   (2) reranked.promoted — a seeded open proposal whose stale score is below
    //       the bar gets re-scored above 60 by rerankAll.
    // The notify body must read "2 proposals", proving the sum, not just one term.
    seedOpenCodeProposal("rerank-promote-1", "seed-sig");
    scanAllImpl.mockResolvedValue([highSignal("fresh", 8)]);
    const effects = noopEffects();

    await runEvolveCycle({ ...baseOpts, effects });

    // Confirm the two surfaces each contributed one promotion.
    expect(proposals.get("rerank-promote-1")!.status).toBe("critical");
    expect(
      [...proposals.values()].filter((p) => p.id !== "rerank-promote-1" && p.status === "critical"),
    ).toHaveLength(1);

    expect(effects.notify).toHaveBeenCalledTimes(1);
    expect(effects.notify.mock.calls[0][0]).toMatchObject({
      type: "evolve_critical",
      body: expect.stringContaining("2 proposals"),
    });

    // A single-promote run yields the SINGULAR phrasing (no digit).
    const single = noopEffects();
    proposals.clear();
    bySignalHash.clear();
    scanAllImpl.mockResolvedValue([highSignal("solo", 8)]);
    await runEvolveCycle({ ...baseOpts, effects: single });
    expect(single.notify).toHaveBeenCalledTimes(1);
    expect(single.notify.mock.calls[0][0]).toMatchObject({
      body: "A proposal was promoted to critical.",
    });
  });
});
