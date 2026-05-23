import { describe, expect, it } from "vitest";
import {
  bucketFrictionByCategory,
  type FrictionCategory,
  type ScoredTurn,
} from "./scan-friction.js";
import type { OrchestratorTurn } from "./scan-friction.js";

function turn(
  i: number,
  category: FrictionCategory,
  friction_score: number,
  overrides: Partial<OrchestratorTurn> = {},
): OrchestratorTurn & ScoredTurn {
  return {
    sessionId: overrides.sessionId ?? "sess-a",
    filePath: overrides.filePath ?? "/tmp/sess-a.jsonl",
    turnId: `t-${i}`,
    ts: overrides.ts ?? `2026-05-01T00:0${i}:00.000Z`,
    userText: `user text ${i}`,
    prevAssistantText: "",
    dbTurnId: `${100 + i}`,
    turn_id: `t-${i}`,
    category,
    friction_score,
    reason: `reason ${i}`,
    ...overrides,
  };
}

describe("scan-friction bucketByCategory", () => {
  it("drops turns with friction_score < 2", () => {
    const out = bucketFrictionByCategory([turn(1, "correction", 1), turn(2, "confusion", 0)]);
    expect(out).toEqual([]);
  });

  it("drops 'none' category even at high score", () => {
    const out = bucketFrictionByCategory([turn(1, "none", 5)]);
    expect(out).toEqual([]);
  });

  it("emits one signal per category, keyed with friction_ prefix", () => {
    const a = bucketFrictionByCategory([turn(1, "correction", 3)]);
    expect(a.length).toBe(1);
    expect(a[0].key).toBe("friction_correction");
    expect(a[0].agent).toBe("orchestrator");

    const b = bucketFrictionByCategory([turn(1, "confusion", 3)]);
    expect(b.length).toBe(1);
    expect(b[0].key).toBe("friction_confusion");
  });

  it("merges multiple turns of the same category and bumps count", () => {
    const turns = Array.from({ length: 3 }, (_, i) => turn(i + 1, "correction", 3));
    const out = bucketFrictionByCategory(turns);
    expect(out.length).toBe(1);
    expect(out[0].count).toBe(3);
  });

  it("escalates severity when a later turn scores higher", () => {
    const out = bucketFrictionByCategory([turn(1, "frustration", 2), turn(2, "frustration", 4)]);
    expect(out.length).toBe(1);
    expect(out[0].severity).toBe("high");
  });

  it("caps evidence pointers at 5", () => {
    const turns = Array.from({ length: 7 }, (_, i) => turn(i + 1, "repeat", 3));
    const out = bucketFrictionByCategory(turns);
    expect(out[0].count).toBe(7);
    expect(out[0].evidencePointers.length).toBe(5);
  });

  it("adds cross-session pointer when cap not yet reached", () => {
    const out = bucketFrictionByCategory([
      turn(1, "redirect", 3, { sessionId: "sess-a" }),
      turn(2, "redirect", 3, { sessionId: "sess-b" }),
    ]);
    expect(out[0].evidencePointers.length).toBe(2);
    const sessions = out[0].evidencePointers.map((p) => p.sessionId);
    expect(sessions).toContain("sess-a");
    expect(sessions).toContain("sess-b");
  });

  it("replaces last same-session pointer with cross-session pointer when cap is full", () => {
    // Fill to cap=5 with sess-a, then add a sess-b turn. sess-b should replace
    // the last sess-a pointer (index 4) so the enricher sees both sessions.
    const sameSess = Array.from({ length: 5 }, (_, i) =>
      turn(i + 1, "doubt", 3, { sessionId: "sess-a" }),
    );
    const crossSess = turn(6, "doubt", 3, { sessionId: "sess-b" });
    const out = bucketFrictionByCategory([...sameSess, crossSess]);
    expect(out[0].evidencePointers.length).toBe(5);
    const sessions = out[0].evidencePointers.map((p) => p.sessionId);
    // At least one pointer should be from sess-b
    expect(sessions).toContain("sess-b");
    // sess-a still represented
    expect(sessions).toContain("sess-a");
  });

  it("does not replace when cap is full but pointers already span multiple sessions", () => {
    // 4 sess-a + 1 sess-b = cap reached, already diverse; a new sess-c should not displace
    const mixed = [
      ...Array.from({ length: 4 }, (_, i) => turn(i + 1, "reset", 3, { sessionId: "sess-a" })),
      turn(5, "reset", 3, { sessionId: "sess-b" }),
    ];
    const extra = turn(6, "reset", 3, { sessionId: "sess-c" });
    const out = bucketFrictionByCategory([...mixed, extra]);
    expect(out[0].evidencePointers.length).toBe(5);
    // sess-c should NOT appear because existing pointers already span sessions
    const sessions = out[0].evidencePointers.map((p) => p.sessionId);
    expect(sessions).not.toContain("sess-c");
  });
});
