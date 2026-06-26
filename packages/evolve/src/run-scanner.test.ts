/**
 * End-to-end pipeline tests for the deep `runScanner` core, driven through the
 * three public entry points (scanFriction / scanPreferences / scanDreaming)
 * with BOTH seams injected — a fake `collectFn` (canned turns, no DB) and a
 * fake `scoreFn` (canned scores, no LLM). This is the coverage the refactor
 * unlocked: before the `collectFn` seam existed, the collect → batch → score →
 * bucket wiring had ZERO tests (only the isolated bucket functions were
 * exercised). The co-located bucket tests still pin the bucketing rules
 * directly; these pin the wiring around them.
 */

import { describe, expect, it, vi } from "vitest";
import { scanFriction, type ScoredTurn, type TurnForScoring } from "./scan-friction.js";
import { scanPreferences, type PreferenceScoredTurn } from "./scan-preferences.js";
import {
  scanDreaming,
  decodeDreamPayload,
  type DreamScoredCandidate,
  type DreamEvidence,
} from "./scan-dreaming.js";
import { SCAN_BATCH_SIZE } from "./run-scanner.js";
import type { OrchestratorTurn } from "./collect.js";

function oturn(i: number, overrides: Partial<OrchestratorTurn> = {}): OrchestratorTurn {
  return {
    sessionId: overrides.sessionId ?? "sess-a",
    filePath: overrides.filePath ?? "/tmp/sess-a.jsonl",
    turnId: `t-${i}`,
    ts: overrides.ts ?? `2026-05-01T00:0${i}:00.000Z`,
    userText: overrides.userText ?? `user text ${i}`,
    prevAssistantText: overrides.prevAssistantText ?? `assistant text ${i}`,
    dbTurnId: overrides.dbTurnId ?? `${100 + i}`,
    ...overrides,
  };
}

/** A collectFn seam that returns a fixed set of turns regardless of args. */
function fixedCollect(turns: OrchestratorTurn[]) {
  return async (_since: number, _max: number) => turns;
}

describe("runScanner — friction pipeline (collect → batch → score → bucket)", () => {
  it("returns [] without scoring when collect yields no turns", async () => {
    const scoreFn = vi.fn();
    const out = await scanFriction({ collectFn: fixedCollect([]), scoreFn, model: "m" });
    expect(out).toEqual([]);
    expect(scoreFn).not.toHaveBeenCalled();
  });

  it("projects each turn through buildPayload and passes opts.model to scoreFn", async () => {
    const turns = [oturn(1, { userText: "x".repeat(900), prevAssistantText: "y".repeat(500) })];
    const scoreFn = vi.fn(
      async (batch: TurnForScoring[], _model: string): Promise<ScoredTurn[]> =>
        batch.map((b) => ({
          turn_id: b.turn_id,
          friction_score: 3,
          category: "correction",
          reason: "",
        })),
    );

    await scanFriction({ collectFn: fixedCollect(turns), scoreFn, model: "haiku-test" });

    expect(scoreFn).toHaveBeenCalledTimes(1);
    const [batch, model] = scoreFn.mock.calls[0];
    expect(model).toBe("haiku-test");
    // buildPayload shape + truncation (user_text cap 800, prev_assistant cap 400).
    expect(batch[0]).toMatchObject({ turn_id: "t-1" });
    expect(batch[0].user_text.length).toBe(800);
    expect(batch[0].prev_assistant_text.length).toBe(400);
  });

  it("drives the cross-session-diversity swap through the real entry point", async () => {
    // 5 sess-a turns fill the 5-cap, then 1 sess-b turn forces the swap so the
    // enricher sees evidence from >1 session. Reachable ONLY via the pipeline.
    const turns = [
      ...Array.from({ length: 5 }, (_, i) => oturn(i + 1, { sessionId: "sess-a" })),
      oturn(6, { sessionId: "sess-b" }),
    ];
    const scoreFn = async (batch: { turn_id: string }[]): Promise<ScoredTurn[]> =>
      batch.map((b) => ({
        turn_id: b.turn_id,
        friction_score: 3,
        category: "doubt",
        reason: "",
      }));

    const out = await scanFriction({ collectFn: fixedCollect(turns), scoreFn, model: "m" });

    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("friction_doubt");
    expect(out[0].count).toBe(6);
    expect(out[0].evidencePointers).toHaveLength(5);
    const sessions = out[0].evidencePointers.map((p) => p.sessionId);
    expect(sessions).toContain("sess-a");
    expect(sessions).toContain("sess-b");
  });

  it("splits into batches of the default SCAN_BATCH_SIZE (30) when no override is given", async () => {
    const turns = Array.from({ length: 65 }, (_, i) => oturn(i + 1));
    const scoreFn = vi.fn(
      async (batch: { turn_id: string }[]): Promise<ScoredTurn[]> =>
        batch.map((b) => ({ turn_id: b.turn_id, friction_score: 0, category: "none", reason: "" })),
    );

    await scanFriction({ collectFn: fixedCollect(turns), scoreFn, model: "m" });

    // 65 turns / default batch 30 → 3 calls of sizes 30, 30, 5.
    expect(SCAN_BATCH_SIZE).toBe(30);
    expect(scoreFn.mock.calls.map((c) => c[0].length)).toEqual([30, 30, 5]);
  });

  it("honors a per-call batchSize override", async () => {
    const turns = Array.from({ length: 7 }, (_, i) => oturn(i + 1));
    const scoreFn = vi.fn(
      async (batch: { turn_id: string }[]): Promise<ScoredTurn[]> =>
        batch.map((b) => ({ turn_id: b.turn_id, friction_score: 0, category: "none", reason: "" })),
    );

    await scanFriction({ collectFn: fixedCollect(turns), scoreFn, model: "m", batchSize: 3 });

    // 7 turns / batch 3 → 3 calls of sizes 3, 3, 1.
    expect(scoreFn.mock.calls.map((c) => c[0].length)).toEqual([3, 3, 1]);
  });

  it("accumulates same-category turns across multiple batches into one merged signal", async () => {
    // batchSize:1 forces three separate surviving batches; the core accumulates
    // into a single `scored` array and buckets ONCE after the loop, so they must
    // merge into one signal with count 3. Catches any per-batch re-init of
    // `scored` or per-batch bucketing regression.
    const turns = Array.from({ length: 3 }, (_, i) => oturn(i + 1, { sessionId: `s${i}` }));
    const scoreFn = async (batch: { turn_id: string }[]): Promise<ScoredTurn[]> =>
      batch.map((b) => ({ turn_id: b.turn_id, friction_score: 3, category: "doubt", reason: "" }));

    const out = await scanFriction({
      collectFn: fixedCollect(turns),
      scoreFn,
      model: "m",
      batchSize: 1,
    });

    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("friction_doubt");
    expect(out[0].count).toBe(3);
  });

  it("logs and continues when one batch throws, scoring the rest", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const turns = Array.from({ length: 4 }, (_, i) => oturn(i + 1, { sessionId: `s${i}` }));
    let call = 0;
    const scoreFn = async (batch: { turn_id: string }[]): Promise<ScoredTurn[]> => {
      call++;
      if (call === 1) throw new Error("batch boom");
      return batch.map((b) => ({
        turn_id: b.turn_id,
        friction_score: 4,
        category: "frustration",
        reason: "",
      }));
    };

    const out = await scanFriction({
      collectFn: fixedCollect(turns),
      scoreFn,
      model: "m",
      batchSize: 2,
    });

    // First batch (turns 1-2) threw → dropped; second batch (turns 3-4) survived.
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain("friction scoring batch");
    errSpy.mockRestore();
  });
});

describe("runScanner — preferences pipeline", () => {
  it("emits one signal per category with the 3-cap and severity escalation", async () => {
    const turns = [
      oturn(1, { sessionId: "s1" }),
      oturn(2, { sessionId: "s2" }),
      oturn(3, { sessionId: "s3" }),
      oturn(4, { sessionId: "s4" }),
      oturn(5, { sessionId: "s5" }),
    ];
    // 4 tooling turns (escalating 2→5) + 1 directive turn.
    const scores: Record<string, PreferenceScoredTurn> = {
      "t-1": { turn_id: "t-1", signal_score: 2, category: "preference_tooling", reason: "" },
      "t-2": { turn_id: "t-2", signal_score: 3, category: "preference_tooling", reason: "" },
      "t-3": { turn_id: "t-3", signal_score: 4, category: "preference_tooling", reason: "" },
      "t-4": { turn_id: "t-4", signal_score: 5, category: "preference_tooling", reason: "" },
      "t-5": { turn_id: "t-5", signal_score: 3, category: "directive", reason: "" },
    };
    const scoreFn = async (batch: { turn_id: string }[]) => batch.map((b) => scores[b.turn_id]);

    const out = await scanPreferences({ collectFn: fixedCollect(turns), scoreFn, model: "m" });

    const tooling = out.find((s) => s.key === "preference_tooling");
    const directive = out.find((s) => s.key === "directive");
    expect(out).toHaveLength(2);
    expect(tooling?.count).toBe(4);
    expect(tooling?.evidencePointers).toHaveLength(3); // capped at 3
    expect(tooling?.severity).toBe("high"); // escalated by the score-5 turn
    expect(directive?.count).toBe(1);
    expect(directive?.severity).toBe("medium");
  });

  it("drops sub-threshold (< 2) and 'none' turns end-to-end", async () => {
    const turns = [oturn(1), oturn(2)];
    const scoreFn = async (_batch: { turn_id: string }[]): Promise<PreferenceScoredTurn[]> => [
      { turn_id: "t-1", signal_score: 1, category: "preference_style", reason: "" },
      { turn_id: "t-2", signal_score: 5, category: "none", reason: "" },
    ];
    const out = await scanPreferences({ collectFn: fixedCollect(turns), scoreFn, model: "m" });
    expect(out).toEqual([]);
  });
});

describe("runScanner — dreaming pipeline", () => {
  function dcand(
    turn_id: string,
    title: string,
    overrides: Partial<DreamScoredCandidate> = {},
  ): DreamScoredCandidate {
    return {
      turn_id,
      signal_score: overrides.signal_score ?? 3,
      category: overrides.category ?? "feedback",
      reason: "",
      proposed_title: title,
      proposed_content: overrides.proposed_content ?? `content for ${title}`,
      proposed_tags: overrides.proposed_tags ?? ["alpha"],
      already_covered: overrides.already_covered,
    };
  }

  it("merges a recurring candidate to one reinforce signal with a decodable payload", async () => {
    const title = "Always deploy via friday update";
    const turns = [
      oturn(1, { ts: "2026-05-01T00:01:00.000Z" }),
      oturn(2, { ts: "2026-05-01T00:05:00.000Z" }),
    ];
    const scoreFn = async (batch: { turn_id: string }[]): Promise<DreamScoredCandidate[]> =>
      batch.map((b) => dcand(b.turn_id, title));

    const out = await scanDreaming({ collectFn: fixedCollect(turns), scoreFn, model: "m" });

    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
    expect(out[0].key).toBe("dream:reinforce:always-deploy-via-friday-update");
    expect(out[0].firstSeenAt).toBe("2026-05-01T00:01:00.000Z");
    expect(out[0].lastSeenAt).toBe("2026-05-01T00:05:00.000Z");
    const payload = decodeDreamPayload(out[0]);
    expect(payload?.title).toBe(title);
    expect(payload?.category).toBe("feedback");
  });

  it("a single non-recurring candidate is a promote signal", async () => {
    const turns = [oturn(1)];
    const scoreFn = async (batch: { turn_id: string }[]): Promise<DreamScoredCandidate[]> =>
      batch.map((b) => dcand(b.turn_id, "Seth works in Pacific time", { category: "user" }));

    const out = await scanDreaming({ collectFn: fixedCollect(turns), scoreFn, model: "m" });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("dream:promote:seth-works-in-pacific-time");
  });

  it("threads DreamEvidence through buildPayload into the scoreFn batch", async () => {
    const turns = [oturn(1)];
    const evidence: DreamEvidence = {
      recallStatsBySlug: new Map(),
      orchestratorName: "friday",
      frictionSignalsInWindow: [
        {
          hash: "h1",
          source: "daemon",
          key: "watchdog.stall.detected",
          severity: "high",
          count: 1,
          firstSeenAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:01:00.000Z",
          agent: "friday",
          evidencePointers: [],
        },
      ],
    };
    const scoreFn = vi.fn(
      async (batch: { turn_id: string }[]): Promise<DreamScoredCandidate[]> =>
        batch.map((b) => dcand(b.turn_id, "Daemon stalls under load")),
    );

    await scanDreaming({ collectFn: fixedCollect(turns), scoreFn, model: "m", evidence });

    // Pin the exact rendered evidence string buildPayload → renderEvidenceForTurn
    // produced for this matching-agent stall signal (no existing-memories line).
    const rendered = (scoreFn.mock.calls[0][0][0] as { evidence?: string }).evidence;
    expect(rendered).toBe("co-occurring daemon signal: watchdog.stall.detected (severity=high)");
  });
});
