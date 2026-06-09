import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVOLVE_DIR, SPIKE_CURSOR_PATH } from "@friday/shared";
import type { UsageEntryRow } from "@friday/shared/services";

vi.mock("@friday/shared/services", () => ({
  getUsageEntriesSince: vi.fn(),
  getAllUsageEntries: vi.fn(),
}));

const { scanUsage, scanTranscripts } = await import("./scan.js");
const { getUsageEntriesSince, getAllUsageEntries } = await import("@friday/shared/services");

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRow(agent: string, tokens: number, ts: string, turnNumber = 2): UsageEntryRow {
  return {
    timestamp: ts,
    sessionId: "sess1",
    agentName: agent,
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    costUsd: 0.01,
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    turnNumber,
    durationMs: 1000,
  };
}

/** Generate N rows for an agent, spaced 1 minute apart starting from baseMs. */
function makeRows(
  agent: string,
  tokensList: number[],
  baseMs = Date.parse("2026-05-01T00:00:00Z"),
  startTurn = 2,
): UsageEntryRow[] {
  return tokensList.map((t, i) =>
    makeRow(agent, t, new Date(baseMs + i * 60_000).toISOString(), startTurn + i),
  );
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(EVOLVE_DIR, { recursive: true });
  if (existsSync(SPIKE_CURSOR_PATH)) rmSync(SPIKE_CURSOR_PATH);
  vi.mocked(getUsageEntriesSince).mockResolvedValue([]);
  vi.mocked(getAllUsageEntries).mockResolvedValue([]);
});

// ── read cursor ────────────────────────────────────────────────────────────────

describe("scanUsage — read cursor", () => {
  it("emits a spike signal on the first scan", async () => {
    // 9 rows at 100 tokens, 1 at 1000 (10× median → above 4× threshold)
    const rows = makeRows("agent-a", [100, 100, 100, 100, 100, 100, 100, 100, 100, 1000]);
    vi.mocked(getUsageEntriesSince).mockResolvedValue(rows);

    const signals = await scanUsage({ since: "2026-04-30T00:00:00Z" });
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe("usage_token_spike");
    expect(signals[0].agent).toBe("agent-a");
  });

  it("does not re-emit the same spikes on a subsequent scan of identical rows", async () => {
    const rows = makeRows("agent-a", [100, 100, 100, 100, 100, 100, 100, 100, 100, 1000]);
    vi.mocked(getUsageEntriesSince).mockResolvedValue(rows);

    await scanUsage({ since: "2026-04-30T00:00:00Z" }); // first scan — advances cursor
    vi.mocked(getUsageEntriesSince).mockResolvedValue(rows); // same rows
    const signals2 = await scanUsage({ since: "2026-04-30T00:00:00Z" });

    expect(signals2).toHaveLength(0);
  });

  it("emits only genuinely new spikes after the cursor", async () => {
    const base = Date.parse("2026-05-01T00:00:00Z");
    const oldRows = makeRows("agent-b", [100, 100, 100, 100, 100, 100, 100, 100, 100, 1000], base);
    vi.mocked(getUsageEntriesSince).mockResolvedValue(oldRows);

    await scanUsage({ since: "2026-04-30T00:00:00Z" }); // cursor advances past all old rows

    // Add one new spike row beyond the cursor position
    const newSpike = makeRow(
      "agent-b",
      2000,
      new Date(base + 60 * 60_000).toISOString(), // 1 hour after the last old row
      12,
    );
    vi.mocked(getUsageEntriesSince).mockResolvedValue([...oldRows, newSpike]);
    const signals2 = await scanUsage({ since: "2026-04-30T00:00:00Z" });

    expect(signals2).toHaveLength(1);
    expect(signals2[0].agent).toBe("agent-b");
  });

  it("cursor is written to SPIKE_CURSOR_PATH after a scan", async () => {
    const rows = makeRows("agent-c", [100, 100, 100, 100, 100]);
    vi.mocked(getUsageEntriesSince).mockResolvedValue(rows);

    expect(existsSync(SPIKE_CURSOR_PATH)).toBe(false);
    await scanUsage({ since: "2026-04-30T00:00:00Z" });
    expect(existsSync(SPIKE_CURSOR_PATH)).toBe(true);
  });
});

// ── cold-resume exclusion ─────────────────────────────────────────────────────

describe("scanUsage — cold-resume exclusion", () => {
  it("does not flag a turn_number=1 row as a spike even when it dwarfs the median", async () => {
    const base = Date.parse("2026-05-01T00:00:00Z");
    // 5 normal turns (turn 2-6 at 100 tokens) — meets the ≥5 minimum
    const normalRows = makeRows("agent-d", [100, 100, 100, 100, 100], base, 2);
    // 1 massive cache-burst on turn 1 (cold resume)
    const coldResume = makeRow(
      "agent-d",
      50_000,
      new Date(base - 60_000).toISOString(), // happened before the normal turns
      1,
    );
    vi.mocked(getUsageEntriesSince).mockResolvedValue([coldResume, ...normalRows]);

    const signals = await scanUsage({ since: "2026-04-30T00:00:00Z" });
    expect(signals).toHaveLength(0);
  });

  it("still detects genuine spikes on turn ≥ 2 even when turn 1 is present", async () => {
    const base = Date.parse("2026-05-01T00:00:00Z");
    // 9 normal turns + 1 genuine spike on turn 11
    const rows = makeRows("agent-e", [100, 100, 100, 100, 100, 100, 100, 100, 100, 1000], base, 2);
    // Cold-resume row — should be excluded from detection
    const coldResume = makeRow("agent-e", 50_000, new Date(base - 60_000).toISOString(), 1);
    vi.mocked(getUsageEntriesSince).mockResolvedValue([coldResume, ...rows]);

    const signals = await scanUsage({ since: "2026-04-30T00:00:00Z" });
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe("usage_token_spike");
  });
});

// ── scanTranscripts ───────────────────────────────────────────────────────────

function writeJsonl(filePath: string, entries: object[]): void {
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function userEntry(text: string, timestamp: string) {
  return { type: "user", message: { role: "user", content: text }, timestamp };
}

function compactEntry(trigger: "manual" | "auto" | undefined, timestamp: string) {
  return {
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: trigger !== undefined ? { trigger } : {},
    timestamp,
  };
}

describe("scanTranscripts", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `fri-scan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpRoot, "proj"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("compact boundary suppression", () => {
    it("does not fire when a manual compact_boundary precedes the second message", () => {
      writeJsonl(join(tmpRoot, "proj", "abc123.jsonl"), [
        userEntry("fix the bug", "2026-05-01T00:00:00.000Z"),
        compactEntry("manual", "2026-05-01T00:01:00.000Z"),
        userEntry("fix the bug", "2026-05-01T00:01:01.000Z"),
      ]);

      const signals = scanTranscripts({ projectsRoot: tmpRoot });
      expect(signals.filter((s) => s.key === "transcript_user_retry")).toHaveLength(0);
    });

    it("fires for a genuine retry when no compact_boundary is present", () => {
      writeJsonl(join(tmpRoot, "proj", "abc124.jsonl"), [
        userEntry("fix the bug", "2026-05-01T00:00:00.000Z"),
        userEntry("fix the bug", "2026-05-01T00:01:00.000Z"),
      ]);

      const signals = scanTranscripts({ projectsRoot: tmpRoot });
      const retrySignals = signals.filter((s) => s.key === "transcript_user_retry");
      expect(retrySignals).toHaveLength(1);
      expect(retrySignals[0].evidencePointers[0].sessionId).toBe("abc124");
    });

    it("does not suppress when compact_boundary trigger is 'auto'", () => {
      writeJsonl(join(tmpRoot, "proj", "abc125.jsonl"), [
        userEntry("fix the bug", "2026-05-01T00:00:00.000Z"),
        compactEntry("auto", "2026-05-01T00:01:00.000Z"),
        userEntry("fix the bug", "2026-05-01T00:01:01.000Z"),
      ]);

      const signals = scanTranscripts({ projectsRoot: tmpRoot });
      expect(signals.filter((s) => s.key === "transcript_user_retry")).toHaveLength(1);
    });

    it("does not suppress when compact_boundary has no trigger field", () => {
      writeJsonl(join(tmpRoot, "proj", "abc126.jsonl"), [
        userEntry("fix the bug", "2026-05-01T00:00:00.000Z"),
        compactEntry(undefined, "2026-05-01T00:01:00.000Z"),
        userEntry("fix the bug", "2026-05-01T00:01:01.000Z"),
      ]);

      const signals = scanTranscripts({ projectsRoot: tmpRoot });
      expect(signals.filter((s) => s.key === "transcript_user_retry")).toHaveLength(1);
    });
  });

  describe("session-scoped dedup", () => {
    it("emits one signal with count=retries for a session with multiple retry pairs", () => {
      // Three identical messages in window → two retry pairs, one signal, count=2.
      writeJsonl(join(tmpRoot, "proj", "sess1.jsonl"), [
        userEntry("please fix the bug", "2026-05-01T00:00:00.000Z"),
        userEntry("please fix the bug", "2026-05-01T00:01:00.000Z"),
        userEntry("please fix the bug", "2026-05-01T00:02:00.000Z"),
      ]);

      const signals = scanTranscripts({ projectsRoot: tmpRoot });
      const retrySignals = signals.filter((s) => s.key === "transcript_user_retry");
      expect(retrySignals).toHaveLength(1);
      expect(retrySignals[0].count).toBe(2);
      expect(retrySignals[0].evidencePointers).toHaveLength(1);
      expect(retrySignals[0].evidencePointers[0].sessionId).toBe("sess1");
    });

    it("accumulates retry counts across multiple sessions", () => {
      writeJsonl(join(tmpRoot, "proj", "sess2.jsonl"), [
        userEntry("please fix the bug", "2026-05-01T00:00:00.000Z"),
        userEntry("please fix the bug", "2026-05-01T00:01:00.000Z"),
      ]);
      writeJsonl(join(tmpRoot, "proj", "sess3.jsonl"), [
        userEntry("please fix the bug", "2026-05-01T00:00:00.000Z"),
        userEntry("please fix the bug", "2026-05-01T00:01:00.000Z"),
      ]);

      const signals = scanTranscripts({ projectsRoot: tmpRoot });
      const retrySignals = signals.filter((s) => s.key === "transcript_user_retry");
      expect(retrySignals).toHaveLength(1);
      expect(retrySignals[0].count).toBe(2);
      const sessionIds = retrySignals[0].evidencePointers.map((p) => p.sessionId);
      expect(sessionIds).toContain("sess2");
      expect(sessionIds).toContain("sess3");
    });
  });
});
