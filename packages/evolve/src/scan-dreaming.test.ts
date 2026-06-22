import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bucketByCandidate,
  decodeDreamPayload,
  type DreamEvidence,
  type DreamScoredCandidate,
} from "./scan-dreaming.js";
import { scoreProposal } from "./rank.js";
import { slugify } from "./apply.js";
import type { OrchestratorTurn } from "./scan-friction.js";

function turn(
  i: number,
  category: DreamScoredCandidate["category"],
  signal_score: number,
  proposed_title: string,
  overrides: Partial<OrchestratorTurn & DreamScoredCandidate> = {},
): OrchestratorTurn & DreamScoredCandidate {
  return {
    sessionId: overrides.sessionId ?? "sess-a",
    filePath: overrides.filePath ?? "",
    turnId: `t-${i}`,
    ts: overrides.ts ?? `2026-05-01T00:0${i}:00.000Z`,
    userText: `user text ${i}`,
    prevAssistantText: "",
    dbTurnId: `${100 + i}`,
    turn_id: `t-${i}`,
    category,
    signal_score,
    reason: `reason ${i}`,
    proposed_title,
    proposed_content: overrides.proposed_content ?? `content for ${proposed_title}`,
    proposed_tags: overrides.proposed_tags ?? ["alpha"],
    already_covered: overrides.already_covered,
    ...overrides,
  };
}

describe("scan-dreaming bucketByCandidate", () => {
  // AC1: fixtures → non-empty Signal[], every source === "dream", and a
  // person-fact fixture yields a candidate whose decoded payload.category is
  // "person".
  it("emits dream signals and a person-category candidate (AC1)", () => {
    const signals = bucketByCandidate([
      turn(1, "user", 3, "Seth works in Pacific time"),
      turn(2, "person", 4, "Dana Chen — Linear admin", {
        proposed_tags: ["person", "person:dana-chen", "linear"],
      }),
    ]);

    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.source === "dream")).toBe(true);

    const personSignal = signals.find((s) => decodeDreamPayload(s)?.category === "person");
    expect(personSignal).toBeDefined();
    const payload = decodeDreamPayload(personSignal!);
    expect(payload?.category).toBe("person");
    expect(payload?.title).toBe("Dana Chen — Linear admin");
    expect(payload?.tags).toContain("person:dana-chen");
  });

  // Spec step 1 / Refinement 2: candidates the LLM judged already covered by an
  // existing memory (already_covered: true) are dropped at bucketing time — the
  // inline-dedup half of the dedup contract (the deterministic searchMemories
  // post-pass is the other half).
  it("drops candidates the LLM marked already_covered", () => {
    const signals = bucketByCandidate([
      turn(1, "feedback", 4, "Already-known fact", { already_covered: true }),
      turn(2, "user", 3, "Genuinely new fact"),
    ]);
    expect(signals).toHaveLength(1);
    expect(decodeDreamPayload(signals[0])?.title).toBe("Genuinely new fact");
  });

  // AC13: same candidate recurring 3× in the window collapses to ONE signal
  // with count === 3 and a "dream:reinforce:" key, AND the recurrence-weighting
  // score delta is exactly the frequencyBoost delta between count-3 and count-1.
  it("merges a recurring candidate and marks it reinforce (AC13)", () => {
    const signals = bucketByCandidate([
      turn(1, "feedback", 3, "Always deploy via friday update", {
        ts: "2026-05-01T00:01:00.000Z",
      }),
      turn(2, "feedback", 3, "Always deploy via friday update", {
        ts: "2026-05-01T00:05:00.000Z",
      }),
      turn(3, "feedback", 3, "Always deploy via friday update", {
        ts: "2026-05-01T00:09:00.000Z",
      }),
    ]);

    expect(signals.length).toBe(1);
    expect(signals[0].count).toBe(3);
    expect(signals[0].key).toContain("dream:reinforce:");
    expect(signals[0].key).toBe("dream:reinforce:always-deploy-via-friday-update");
    expect(signals[0].firstSeenAt).toBe("2026-05-01T00:01:00.000Z");
    expect(signals[0].lastSeenAt).toBe("2026-05-01T00:09:00.000Z");

    // Score-delta half: a single-occurrence baseline candidate of the SAME
    // severity (signal_score 3 → "medium") scores below the count-3 signal by
    // exactly the frequencyBoost delta. From rank.ts constants (severity medium
    // floor = 20, frequencyBoost = min(40, log2(totalCount+1)*12), distinctBoost
    // = 0, blast low penalty = 0):
    //   count-3  = round(20 + min(40, log2(4)*12)) = round(20 + 24) = 44
    //   count-1  = round(20 + min(40, log2(2)*12)) = round(20 + 12) = 32
    //   delta    = min(40, log2(4)*12) - min(40, log2(2)*12) = 24 - 12 = 12
    const count3 = signals[0];
    const [count1] = bucketByCandidate([
      turn(9, "feedback", 3, "Prefer pnpm over npm", { ts: "2026-05-01T00:01:00.000Z" }),
    ]);
    expect(count3.severity).toBe("medium");
    expect(count1.severity).toBe("medium");
    expect(count1.count).toBe(1);

    const count3Score = scoreProposal({ signals: [count3], blastRadius: "low" });
    const count1Score = scoreProposal({ signals: [count1], blastRadius: "low" });
    expect(count3Score).toBe(44);
    expect(count1Score).toBe(32);
    expect(count3Score - count1Score).toBe(12);
  });

  // AC14: friction evidence carrying watchdog.stall.detected for the CONFIGURED
  // orchestrator agent (the real agent name from daemon.jsonl, e.g. "friday")
  // → the candidate's evidencePointers cite that event name. An agentless daemon
  // signal (db.checkpoint.error with no agent) is NOT attached — it would
  // over-attribute unrelated daemon errors to every candidate.
  it("cites a matching-agent friction stall event, not an agentless daemon signal (AC14)", () => {
    const evidence: DreamEvidence = {
      recallStatsBySlug: new Map(),
      orchestratorName: "friday",
      frictionSignalsInWindow: [
        {
          hash: "stall01",
          source: "daemon",
          key: "watchdog.stall.detected",
          severity: "high",
          count: 2,
          firstSeenAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:02:00.000Z",
          // Real agent name from daemon.jsonl — equals the configured orchestrator.
          agent: "friday",
          evidencePointers: [],
        },
        {
          // Agentless daemon signal — unrelated infra error, must NOT be attached.
          hash: "ckpt01",
          source: "daemon",
          key: "db.checkpoint.error",
          severity: "high",
          count: 1,
          firstSeenAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:01:00.000Z",
          evidencePointers: [],
        },
      ],
    };

    const signals = bucketByCandidate(
      [turn(1, "project", 3, "Daemon stalls under load when X")],
      evidence,
    );

    expect(signals.length).toBe(1);
    const notePaths = signals[0].evidencePointers.map((p) => p.path);
    // First pointer is the payload; a later note pointer cites the stall event.
    expect(notePaths.some((p) => p.includes("watchdog.stall.detected"))).toBe(true);
    expect(notePaths).toContain("friction: watchdog.stall.detected");
    // Negative case: the agentless daemon signal is NOT attached.
    expect(notePaths.some((p) => p.includes("db.checkpoint.error"))).toBe(false);
    expect(notePaths).not.toContain("friction: db.checkpoint.error");
  });

  // AC12: a high-recall candidate (recallCount >= 10) gets a one-level severity
  // bump → its bucketByCandidate signal is higher severity, and feeding both
  // signals through scoreProposal the high-recall score is strictly greater.
  // Base signal_score 2 → "low"; bump → "medium". Exact integer scores computed
  // from rank.ts constants (SEVERITY_WEIGHT low=5/medium=20, frequencyBoost
  // min(40, log2(1+1)*12)=12, distinctBoost=0, blast low penalty=0):
  //   low-recall  = round(5 + 12) = 17
  //   high-recall = round(20 + 12) = 32
  it("reinforces severity + score from recall stats (AC12)", () => {
    const highTitle = "Seth prefers terse answers";
    const lowTitle = "Seth uses zsh";

    const evidence: DreamEvidence = {
      // Keyed by slug (F14) — the same identity used for dedup/apply.
      recallStatsBySlug: new Map([
        [slugify(highTitle), { recallCount: 12, lastRecalledAt: "2026-05-01T00:00:00.000Z" }],
      ]),
      frictionSignalsInWindow: [],
    };

    const highSignals = bucketByCandidate([turn(1, "user", 2, highTitle)], evidence);
    const lowSignals = bucketByCandidate([turn(1, "user", 2, lowTitle)], evidence);

    expect(highSignals.length).toBe(1);
    expect(lowSignals.length).toBe(1);

    expect(lowSignals[0].severity).toBe("low");
    expect(highSignals[0].severity).toBe("medium");

    const lowScore = scoreProposal({ signals: lowSignals, blastRadius: "low" });
    const highScore = scoreProposal({ signals: highSignals, blastRadius: "low" });

    expect(lowScore).toBe(17);
    expect(highScore).toBe(32);
    expect(highScore).toBeGreaterThan(lowScore);

    // The recall stat is recorded in the candidate's evidencePointers, not in
    // any new Signal field.
    const notePaths = highSignals[0].evidencePointers.map((p) => p.path);
    expect(notePaths.some((p) => p.includes("recallCount=12"))).toBe(true);
  });

  // AC10: preserve-over-delete — scan-dreaming.ts must never reference
  // forgetEntry (the hard-delete primitive).
  it("never references forgetEntry (AC10)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "scan-dreaming.ts"), "utf8");
    expect(src).not.toMatch(/forgetEntry/);
  });
});
