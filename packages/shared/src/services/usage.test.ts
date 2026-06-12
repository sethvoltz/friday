import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "../db/test-pg.js";

// Per ADR-023, tests run against a per-file Postgres scratch DB. The harness
// sets DATABASE_URL and resets the client singleton before any service module
// under test imports it. We `await import(...)` so the dynamic import binds to
// the post-handle env.
let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "usage_svc" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

// Regression: the aggregate SUMs were cast `::int` (int4, max 2,147,483,647).
// Each row's token columns are int4 and individually in-range, but their
// lifetime SUM crossed the ceiling once real usage accumulated, so Postgres
// threw `integer out of range` and the whole /dashboard route 500'd. The fix
// casts the SUMs to ::float8. These tests pin the overflow boundary by summing
// rows whose total exceeds int4 max.
const INT4_MAX = 2_147_483_647;
const PER_ROW = 1_000_000_000; // in-range for an int4 column
const ROWS = 3; // 3e9 > int4 max — the SUM overflows under the old ::int cast

describe("usage stats: int4 overflow regression", () => {
  async function seedOverflowRows(): Promise<void> {
    const { bulkInsertUsage } = await import("./usage.js");
    await bulkInsertUsage(
      Array.from({ length: ROWS }, (_, i) => ({
        // All in the same local day + same model + same session so each
        // aggregate path (lifetime, per-day-model, per-session) sums all rows.
        timestamp: new Date(2026, 0, 15, 12, i).toISOString(),
        sessionId: "sess-overflow",
        agentName: "friday",
        agentType: "orchestrator",
        model: "claude-opus-4-8",
        costUsd: 1.5,
        inputTokens: PER_ROW,
        outputTokens: PER_ROW,
        cacheCreationTokens: PER_ROW,
        cacheReadTokens: PER_ROW,
        durationMs: PER_ROW,
      })),
    );
  }

  it("getUsageStats (lifetime) sums past int4 max without throwing", async () => {
    await seedOverflowRows();
    const { getUsageStats } = await import("./usage.js");

    const stats = await getUsageStats(); // lifetime — the path that 500'd
    const expectedSum = PER_ROW * ROWS;
    expect(expectedSum).toBeGreaterThan(INT4_MAX); // guard: we're actually testing overflow
    expect(stats).toMatchObject({
      turns: ROWS,
      cacheRead: expectedSum,
      cacheCreation: expectedSum,
      output: expectedSum,
      duration: expectedSum,
      // input = inputRaw + cacheCreation + cacheRead
      input: expectedSum * 3,
    });
  });

  it("getSessionStats sums a long-lived session past int4 max", async () => {
    await seedOverflowRows();
    const { getSessionStats } = await import("./usage.js");

    const stats = await getSessionStats("sess-overflow");
    expect(stats).toMatchObject({
      turnCount: ROWS,
      totalCacheReadTokens: PER_ROW * ROWS,
      totalCacheCreationTokens: PER_ROW * ROWS,
      totalInputTokens: PER_ROW * ROWS,
      totalOutputTokens: PER_ROW * ROWS,
      totalDurationMs: PER_ROW * ROWS,
    });
    expect(stats!.totalCacheReadTokens).toBeGreaterThan(INT4_MAX);
  });

  it("getDailyByModel sums a single heavy day-bucket past int4 max", async () => {
    await seedOverflowRows();
    const { getDailyByModel } = await import("./usage.js");

    const rows = await getDailyByModel();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "claude-opus-4-8",
      cacheRead: PER_ROW * ROWS,
      cacheCreation: PER_ROW * ROWS,
      rawInput: PER_ROW * ROWS,
      output: PER_ROW * ROWS,
      turns: ROWS,
    });
    expect(rows[0].cacheRead).toBeGreaterThan(INT4_MAX);
  });
});

describe("getLatestUsageForAgent + estimateContextTokens (FRI-156 §C sweep estimate)", () => {
  it("returns the newest-by-timestamp row for an agent", async () => {
    const { bulkInsertUsage, getLatestUsageForAgent } = await import("./usage.js");
    // Three rows for one agent across distinct timestamps, inserted
    // out-of-timestamp-order so an ORDER BY timestamp DESC (not insert order)
    // is the only thing that picks the newest.
    await bulkInsertUsage([
      {
        timestamp: new Date(2026, 0, 15, 10, 0).toISOString(),
        sessionId: "sess-A",
        agentName: "friday",
        costUsd: 1,
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationTokens: 200,
        cacheReadTokens: 300,
      },
      {
        // Newest by timestamp, but inserted in the middle of the batch.
        timestamp: new Date(2026, 0, 15, 14, 0).toISOString(),
        sessionId: "sess-B",
        agentName: "friday",
        costUsd: 1,
        inputTokens: 111,
        outputTokens: 22,
        cacheCreationTokens: 222,
        cacheReadTokens: 333,
      },
      {
        timestamp: new Date(2026, 0, 15, 12, 0).toISOString(),
        sessionId: "sess-A",
        agentName: "friday",
        costUsd: 1,
        inputTokens: 105,
        outputTokens: 15,
        cacheCreationTokens: 205,
        cacheReadTokens: 305,
      },
    ]);

    const latest = await getLatestUsageForAgent("friday");
    expect(latest).toMatchObject({
      inputTokens: 111,
      outputTokens: 22,
      cacheCreationTokens: 222,
      cacheReadTokens: 333,
    });
    expect(latest!.timestamp.toISOString()).toBe(new Date(2026, 0, 15, 14, 0).toISOString());
  });

  it("scopes to the supplied sessionId, ignoring newer rows on other sessions", async () => {
    const { bulkInsertUsage, getLatestUsageForAgent } = await import("./usage.js");
    await bulkInsertUsage([
      {
        // Newest overall, but session sess-OLD.
        timestamp: new Date(2026, 0, 15, 14, 0).toISOString(),
        sessionId: "sess-OLD",
        agentName: "friday",
        costUsd: 1,
        inputTokens: 999,
        outputTokens: 99,
        cacheCreationTokens: 999,
        cacheReadTokens: 999,
      },
      {
        // Newest *within* sess-NEW.
        timestamp: new Date(2026, 0, 15, 13, 0).toISOString(),
        sessionId: "sess-NEW",
        agentName: "friday",
        costUsd: 1,
        inputTokens: 50,
        outputTokens: 5,
        cacheCreationTokens: 60,
        cacheReadTokens: 70,
      },
      {
        timestamp: new Date(2026, 0, 15, 11, 0).toISOString(),
        sessionId: "sess-NEW",
        agentName: "friday",
        costUsd: 1,
        inputTokens: 40,
        outputTokens: 4,
        cacheCreationTokens: 50,
        cacheReadTokens: 60,
      },
    ]);

    const scoped = await getLatestUsageForAgent("friday", "sess-NEW");
    expect(scoped).toMatchObject({
      inputTokens: 50,
      cacheCreationTokens: 60,
      cacheReadTokens: 70,
    });
    expect(scoped!.timestamp.toISOString()).toBe(new Date(2026, 0, 15, 13, 0).toISOString());
  });

  it("returns null when the agent has no usage rows", async () => {
    const { getLatestUsageForAgent } = await import("./usage.js");
    expect(await getLatestUsageForAgent("nobody")).toBeNull();
    expect(await getLatestUsageForAgent("nobody", "sess-x")).toBeNull();
  });

  it("estimateContextTokens returns inputTokens only (cache fields are subsets, not additive) (FRI-71)", async () => {
    const { estimateContextTokens } = await import("./usage.js");
    // Cache tokens are subsets of inputTokens; adding them inflated estimates 2-3x.
    expect(
      estimateContextTokens({ inputTokens: 100, cacheCreationTokens: 200, cacheReadTokens: 300 }),
    ).toBe(100);
    const row = { inputTokens: 111, cacheCreationTokens: 222, cacheReadTokens: 333 };
    expect(estimateContextTokens(row)).toBe(111);
    // Zero cache fields — result unchanged.
    expect(estimateContextTokens({ inputTokens: 81_000, cacheCreationTokens: 0, cacheReadTokens: 0 })).toBe(81_000);
  });
});
