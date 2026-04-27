import { describe, it, expect } from "vitest";
import { isCritical, scoreProposal } from "./rank.js";
import type { Signal } from "./store.js";

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    hash: "h",
    source: "daemon",
    key: "agent_loop_error",
    severity: "high",
    count: 1,
    firstSeenAt: "2026-04-26T00:00:00.000Z",
    lastSeenAt: "2026-04-26T00:00:00.000Z",
    evidencePointers: [],
    ...overrides,
  };
}

describe("scoreProposal", () => {
  it("is zero with no signals", () => {
    expect(scoreProposal({ signals: [], blastRadius: "low" })).toBe(0);
  });

  it("a single low-frequency high-severity signal scores in the actionable range", () => {
    const s = scoreProposal({ signals: [signal({ count: 1 })], blastRadius: "low" });
    expect(s).toBeGreaterThanOrEqual(40);
    expect(s).toBeLessThan(80);
  });

  it("frequency boost moves a high signal into critical territory", () => {
    const s = scoreProposal({ signals: [signal({ count: 32 })], blastRadius: "low" });
    expect(s).toBeGreaterThanOrEqual(80);
  });

  it("blast radius drags the score down", () => {
    const low = scoreProposal({ signals: [signal({ count: 8 })], blastRadius: "low" });
    const high = scoreProposal({ signals: [signal({ count: 8 })], blastRadius: "high" });
    expect(high).toBeLessThan(low);
  });

  it("multiple distinct signals add a small boost", () => {
    const one = scoreProposal({ signals: [signal({ hash: "a" })], blastRadius: "low" });
    const three = scoreProposal({
      signals: [signal({ hash: "a" }), signal({ hash: "b" }), signal({ hash: "c" })],
      blastRadius: "low",
    });
    expect(three).toBeGreaterThan(one);
  });

  it("uses the highest severity floor across signals", () => {
    const mixed = scoreProposal({
      signals: [signal({ severity: "low", count: 1 }), signal({ severity: "high", count: 1 })],
      blastRadius: "low",
    });
    const lowOnly = scoreProposal({
      signals: [signal({ severity: "low", count: 1 })],
      blastRadius: "low",
    });
    expect(mixed).toBeGreaterThan(lowOnly);
  });
});

describe("isCritical", () => {
  const rule = { criticalScore: 80, criticalFrequency: 5 };

  it("requires score above threshold", () => {
    const verdict = isCritical(
      { score: 70, signals: [signal({ severity: "high", count: 10 })] },
      rule
    );
    expect(verdict).toBe(false);
  });

  it("escalates when score >= threshold and severity is high", () => {
    expect(isCritical({ score: 85, signals: [signal({ severity: "high", count: 1 })] }, rule)).toBe(true);
  });

  it("escalates when score >= threshold and frequency >= criticalFrequency", () => {
    expect(
      isCritical({ score: 85, signals: [signal({ severity: "low", count: 6 })] }, rule)
    ).toBe(true);
  });

  it("does not escalate when score >= threshold but signals are mild + infrequent", () => {
    expect(
      isCritical({ score: 85, signals: [signal({ severity: "low", count: 2 })] }, rule)
    ).toBe(false);
  });
});
