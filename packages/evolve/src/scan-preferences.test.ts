import { describe, expect, it } from "vitest";
import {
  bucketByCategory,
  type PreferenceCategory,
  type PreferenceScoredTurn,
} from "./scan-preferences.js";
import type { OrchestratorTurn } from "./scan-friction.js";

function turn(
  i: number,
  category: PreferenceCategory,
  signal_score: number,
  overrides: Partial<OrchestratorTurn> = {},
): OrchestratorTurn & PreferenceScoredTurn {
  return {
    sessionId: overrides.sessionId ?? "sess-a",
    filePath: overrides.filePath ?? "/tmp/sess-a.jsonl",
    turnId: `t-${i}`,
    ts: overrides.ts ?? `2026-05-01T00:0${i}:00.000Z`,
    userText: `user text ${i}`,
    prevAssistantText: "",
    dbTurnId: 100 + i,
    turn_id: `t-${i}`,
    category,
    signal_score,
    reason: `reason ${i}`,
    ...overrides,
  };
}

describe("scan-preferences bucketByCategory", () => {
  it("drops turns with signal_score < 2", () => {
    const out = bucketByCategory([
      turn(1, "preference_tooling", 1),
      turn(2, "directive", 0),
    ]);
    expect(out).toEqual([]);
  });

  it("drops 'none' category even at high score", () => {
    const out = bucketByCategory([turn(1, "none", 5)]);
    expect(out).toEqual([]);
  });

  it("emits one signal per category for the orchestrator agent", () => {
    const out = bucketByCategory([
      turn(1, "preference_tooling", 3),
      turn(2, "preference_workflow", 2),
    ]);
    expect(out.length).toBe(2);
    const keys = out.map((s) => s.key).sort();
    expect(keys).toEqual(["preference_tooling", "preference_workflow"]);
    expect(out.every((s) => s.agent === "orchestrator")).toBe(true);
    expect(out.every((s) => s.source === "transcript")).toBe(true);
  });

  it("merges multiple turns of the same category into one bucket and bumps count", () => {
    const out = bucketByCategory([
      turn(1, "preference_tooling", 3, { ts: "2026-05-01T00:01:00.000Z" }),
      turn(2, "preference_tooling", 2, { ts: "2026-05-01T00:05:00.000Z" }),
      turn(3, "preference_tooling", 2, { ts: "2026-05-01T00:10:00.000Z" }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].key).toBe("preference_tooling");
    expect(out[0].count).toBe(3);
    expect(out[0].firstSeenAt).toBe("2026-05-01T00:01:00.000Z");
    expect(out[0].lastSeenAt).toBe("2026-05-01T00:10:00.000Z");
  });

  it("escalates merged severity when a later turn scores higher", () => {
    const out = bucketByCategory([
      turn(1, "directive", 2),
      turn(2, "directive", 4),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].severity).toBe("high");
  });

  it("caps evidence pointers at 3", () => {
    const out = bucketByCategory([
      turn(1, "external_pointer", 3),
      turn(2, "external_pointer", 3),
      turn(3, "external_pointer", 3),
      turn(4, "external_pointer", 3),
      turn(5, "external_pointer", 3),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].count).toBe(5);
    expect(out[0].evidencePointers.length).toBe(3);
  });

  it("maps signal_score to severity (low/medium/high)", () => {
    const low = bucketByCategory([turn(1, "preference_style", 2)]);
    const med = bucketByCategory([turn(1, "preference_style", 3)]);
    const high = bucketByCategory([turn(1, "preference_style", 5)]);
    expect(low[0].severity).toBe("low");
    expect(med[0].severity).toBe("medium");
    expect(high[0].severity).toBe("high");
  });
});
