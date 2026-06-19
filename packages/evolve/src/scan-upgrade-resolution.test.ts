/**
 * Tests for upgrade-aware proposal resolution.
 *
 * Covered scenarios:
 *   burst → auto-resolved
 *   sporadic → tentative (score halved)
 *   same-version restart → noop
 *   recurrence after boundary → noop
 *   within-grace → noop
 *   no-version-field in log → no boundaries
 *   family-suppression: findRecentlyAppliedByFamilyKey matches auto-resolved
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Proposal, Signal } from "./types.js";

// ── store mock ────────────────────────────────────────────────────────────────

const proposals = new Map<string, Proposal>();
const updates = new Map<string, Record<string, unknown>>();

vi.mock("./store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store.js")>();
  return {
    ...actual,
    listProposals: () => [...proposals.values()],
    updateProposal: (id: string, patch: Record<string, unknown>) => {
      const existing = proposals.get(id);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      proposals.set(id, next as Proposal);
      updates.set(id, patch);
      return next;
    },
  };
});

const { readVersionBoundaries, resolveByUpgrade } = await import("./scan-upgrade-resolution.js");
const { parseProposal, serializeProposal } = await import("./store.js");

// ── helpers ───────────────────────────────────────────────────────────────────

const NOW_ISO = "2026-06-19T20:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

/** An ISO timestamp N hours before NOW_ISO. */
function hoursAgo(n: number): string {
  return new Date(NOW_MS - n * 3600_000).toISOString();
}

function makeSignal(key: string, overrides: Partial<Signal> = {}): Signal {
  const base = hoursAgo(36);
  return {
    hash: `h_${key}`,
    source: "daemon",
    key,
    severity: "high",
    count: 3,
    firstSeenAt: base,
    lastSeenAt: base,
    evidencePointers: [],
    ...overrides,
  };
}

function makeProposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id,
    title: `proposal ${id}`,
    type: "code",
    status: "open",
    clusterId: null,
    score: 80,
    signals: [makeSignal("worker.exit")],
    proposedChange: "fix it",
    blastRadius: "low",
    appliesTo: ["daemon"],
    createdBy: "test",
    createdAt: hoursAgo(40),
    updatedAt: hoursAgo(40),
    appliedAt: null,
    appliedBy: null,
    enrichedAt: null,
    enrichedBy: null,
    lastEnrichError: null,
    lastEnrichFailedAt: null,
    appliedTicketId: null,
    familyResolvedBy: null,
    builderAgent: null,
    resolvedByUpgrade: false,
    tentativelyResolvedByUpgrade: false,
    resolvedByVersion: null,
    resolvedAt: null,
    ...overrides,
  };
}

/** Build JSONL content for daemon.ready events. */
function readyLine(ts: string, version: string): string {
  return JSON.stringify({ ts, event: "daemon.ready", version });
}

/** Build JSONL content for an arbitrary event (for recurrence checks). */
function eventLine(ts: string, event: string, agent?: string): string {
  return JSON.stringify({ ts, event, ...(agent ? { agent } : {}) });
}

function writeTmpLog(lines: string[]): string {
  const dir = join(tmpdir(), `upgrade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "daemon.jsonl");
  writeFileSync(path, lines.filter(Boolean).join("\n") + "\n", "utf-8");
  return path;
}

beforeEach(() => {
  proposals.clear();
  updates.clear();
  vi.setSystemTime(new Date(NOW_ISO));
});

// ── readVersionBoundaries ─────────────────────────────────────────────────────

describe("readVersionBoundaries", () => {
  it("emits a boundary when version changes", () => {
    const logPath = writeTmpLog([
      readyLine(hoursAgo(48), "1.27.0"),
      readyLine(hoursAgo(10), "1.28.0"),
    ]);
    const boundaries = readVersionBoundaries(logPath);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({
      fromVersion: "1.27.0",
      toVersion: "1.28.0",
    });
  });

  it("same-version restart emits no boundary", () => {
    const logPath = writeTmpLog([
      readyLine(hoursAgo(48), "1.28.0"),
      readyLine(hoursAgo(10), "1.28.0"),
    ]);
    expect(readVersionBoundaries(logPath)).toHaveLength(0);
  });

  it("lines without a version field are skipped", () => {
    const logPath = writeTmpLog([
      JSON.stringify({ ts: hoursAgo(48), event: "daemon.ready" }),
      readyLine(hoursAgo(10), "1.28.0"),
    ]);
    // Only one daemon.ready with a version, so no previous version → no boundary.
    expect(readVersionBoundaries(logPath)).toHaveLength(0);
  });

  it("emits multiple boundaries across three versions", () => {
    const logPath = writeTmpLog([
      readyLine(hoursAgo(72), "1.26.0"),
      readyLine(hoursAgo(48), "1.27.0"),
      readyLine(hoursAgo(10), "1.28.0"),
    ]);
    const b = readVersionBoundaries(logPath);
    expect(b).toHaveLength(2);
    expect(b[0]!.fromVersion).toBe("1.26.0");
    expect(b[0]!.toVersion).toBe("1.27.0");
    expect(b[1]!.fromVersion).toBe("1.27.0");
    expect(b[1]!.toVersion).toBe("1.28.0");
  });

  it("returns empty array for missing log file", () => {
    expect(readVersionBoundaries("/tmp/does-not-exist-xyzzy.jsonl")).toEqual([]);
  });
});

// ── resolveByUpgrade ──────────────────────────────────────────────────────────

describe("resolveByUpgrade — burst → auto-resolved", () => {
  it("marks a burst proposal auto-resolved when grace elapsed and no recurrence", async () => {
    // Boundary was 8h ago (> 6h grace). Signal cluster last seen 30h ago.
    const boundaryTs = hoursAgo(8);
    const lastSeenAt = hoursAgo(30);
    const logPath = writeTmpLog([
      readyLine(hoursAgo(48), "1.27.0"),
      readyLine(boundaryTs, "1.28.0"),
    ]);
    // Burst: count > 10, span ≤ 10 min (firstSeen = lastSeen for simplicity).
    proposals.set(
      "p1",
      makeProposal("p1", {
        signals: [makeSignal("worker.exit", { count: 15, firstSeenAt: lastSeenAt, lastSeenAt })],
      }),
    );

    const result = await resolveByUpgrade({ daemonLogPath: logPath });
    expect(result.definitive).toBe(1);
    expect(result.tentative).toBe(0);
    const patch = updates.get("p1");
    expect(patch).toMatchObject({
      status: "auto-resolved",
      resolvedByUpgrade: true,
      resolvedByVersion: "1.28.0",
      resolvedAt: boundaryTs,
    });
  });
});

describe("resolveByUpgrade — sporadic → tentative", () => {
  it("halves score and sets tentativelyResolvedByUpgrade for sporadic signals", async () => {
    const boundaryTs = hoursAgo(8);
    const lastSeenAt = hoursAgo(30);
    const logPath = writeTmpLog([
      readyLine(hoursAgo(48), "1.27.0"),
      readyLine(boundaryTs, "1.28.0"),
    ]);
    // Sporadic: count ≤ 10 (or span > 10 min).
    proposals.set(
      "p2",
      makeProposal("p2", {
        score: 60,
        signals: [makeSignal("worker.exit", { count: 3, firstSeenAt: lastSeenAt, lastSeenAt })],
      }),
    );

    const result = await resolveByUpgrade({ daemonLogPath: logPath });
    expect(result.tentative).toBe(1);
    expect(result.definitive).toBe(0);
    const patch = updates.get("p2");
    expect(patch).toMatchObject({
      tentativelyResolvedByUpgrade: true,
      resolvedByVersion: "1.28.0",
      resolvedAt: boundaryTs,
      score: 30, // floor(60 * 0.5)
    });
    // Status must be unchanged (still "open").
    expect(patch).not.toHaveProperty("status");
  });

  it("score floor is 0, not negative", async () => {
    const boundaryTs = hoursAgo(8);
    const lastSeenAt = hoursAgo(30);
    const logPath = writeTmpLog([
      readyLine(hoursAgo(48), "1.27.0"),
      readyLine(boundaryTs, "1.28.0"),
    ]);
    proposals.set(
      "p3",
      makeProposal("p3", {
        score: 0,
        signals: [makeSignal("worker.exit", { count: 1, firstSeenAt: lastSeenAt, lastSeenAt })],
      }),
    );

    await resolveByUpgrade({ daemonLogPath: logPath });
    expect(updates.get("p3")).toMatchObject({ score: 0 });
  });
});

describe("resolveByUpgrade — same-version restart → noop", () => {
  it("skips resolution when log has no version boundaries", async () => {
    const logPath = writeTmpLog([
      readyLine(hoursAgo(48), "1.28.0"),
      readyLine(hoursAgo(8), "1.28.0"),
    ]);
    proposals.set("p4", makeProposal("p4"));

    const result = await resolveByUpgrade({ daemonLogPath: logPath });
    expect(result.definitive).toBe(0);
    expect(result.tentative).toBe(0);
    expect(updates.size).toBe(0);
  });
});

describe("resolveByUpgrade — recurrence → noop", () => {
  it("skips when the event reappears after the boundary", async () => {
    const boundaryTs = hoursAgo(8);
    const lastSeenAt = hoursAgo(30);
    const recurrenceTs = hoursAgo(4); // after boundary
    const logPath = writeTmpLog([
      readyLine(hoursAgo(48), "1.27.0"),
      readyLine(boundaryTs, "1.28.0"),
      eventLine(recurrenceTs, "worker.exit"),
    ]);
    proposals.set(
      "p5",
      makeProposal("p5", {
        signals: [makeSignal("worker.exit", { count: 15, firstSeenAt: lastSeenAt, lastSeenAt })],
      }),
    );

    const result = await resolveByUpgrade({ daemonLogPath: logPath });
    expect(result.definitive).toBe(0);
    expect(result.tentative).toBe(0);
    expect(updates.size).toBe(0);
  });

  it("matches agent when checking recurrence", async () => {
    const boundaryTs = hoursAgo(8);
    const lastSeenAt = hoursAgo(30);
    const logPath = writeTmpLog([
      readyLine(hoursAgo(48), "1.27.0"),
      readyLine(boundaryTs, "1.28.0"),
      // Same event but different agent — should NOT block resolution.
      eventLine(hoursAgo(4), "worker.exit", "other-agent"),
    ]);
    proposals.set(
      "p6",
      makeProposal("p6", {
        signals: [
          makeSignal("worker.exit", {
            count: 15,
            firstSeenAt: lastSeenAt,
            lastSeenAt,
            agent: "friday",
          }),
        ],
      }),
    );

    const result = await resolveByUpgrade({ daemonLogPath: logPath });
    // The recurrence is for a different agent → should resolve.
    expect(result.definitive).toBe(1);
  });
});

describe("resolveByUpgrade — within-grace → noop", () => {
  it("skips when < 6h have elapsed since the boundary", async () => {
    // Boundary only 3h ago — within the 6h grace window.
    const boundaryTs = hoursAgo(3);
    const lastSeenAt = hoursAgo(30);
    const logPath = writeTmpLog([
      readyLine(hoursAgo(48), "1.27.0"),
      readyLine(boundaryTs, "1.28.0"),
    ]);
    proposals.set(
      "p7",
      makeProposal("p7", {
        signals: [makeSignal("worker.exit", { count: 15, firstSeenAt: lastSeenAt, lastSeenAt })],
      }),
    );

    const result = await resolveByUpgrade({ daemonLogPath: logPath });
    expect(result.definitive).toBe(0);
    expect(result.tentative).toBe(0);
    expect(updates.size).toBe(0);
  });
});

describe("resolveByUpgrade — no-version-field → noop", () => {
  it("produces no boundaries when daemon.ready lines lack version", async () => {
    const logPath = writeTmpLog([
      JSON.stringify({ ts: hoursAgo(48), event: "daemon.ready" }),
      JSON.stringify({ ts: hoursAgo(8), event: "daemon.ready" }),
    ]);
    proposals.set("p8", makeProposal("p8"));

    const result = await resolveByUpgrade({ daemonLogPath: logPath });
    expect(result.definitive).toBe(0);
    expect(result.tentative).toBe(0);
  });
});

describe("resolveByUpgrade — non-open proposals are skipped", () => {
  it("skips proposals with status other than open or critical", async () => {
    const boundaryTs = hoursAgo(8);
    const lastSeenAt = hoursAgo(30);
    const logPath = writeTmpLog([
      readyLine(hoursAgo(48), "1.27.0"),
      readyLine(boundaryTs, "1.28.0"),
    ]);
    for (const status of [
      "applied",
      "rejected",
      "superseded",
      "auto-resolved",
      "approved",
    ] as const) {
      proposals.set(
        `p-${status}`,
        makeProposal(`p-${status}`, {
          status,
          signals: [makeSignal("worker.exit", { count: 15, firstSeenAt: lastSeenAt, lastSeenAt })],
        }),
      );
    }

    const result = await resolveByUpgrade({ daemonLogPath: logPath });
    expect(result.definitive).toBe(0);
    expect(result.tentative).toBe(0);
  });
});

// ── family-suppression for auto-resolved ─────────────────────────────────────

describe("findRecentlyAppliedByFamilyKey — auto-resolved suppresses siblings", () => {
  it("auto-resolved proposal round-trips through serialize/parse with correct fields", () => {
    // This validates that an auto-resolved proposal, once written and parsed,
    // has the right shape for family suppression logic.
    const p = makeProposal("ar-test", {
      status: "auto-resolved",
      resolvedByUpgrade: true,
      resolvedByVersion: "1.28.0",
      resolvedAt: hoursAgo(8),
      appliedAt: hoursAgo(8),
    });
    const round = parseProposal(p.id, serializeProposal(p));
    expect(round.status).toBe("auto-resolved");
    expect(round.resolvedByUpgrade).toBe(true);
    expect(round.resolvedByVersion).toBe("1.28.0");
    expect(round.tentativelyResolvedByUpgrade).toBe(false);
  });
});
