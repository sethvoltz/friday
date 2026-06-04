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
