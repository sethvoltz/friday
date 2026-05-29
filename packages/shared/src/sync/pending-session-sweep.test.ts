/**
 * End-to-end Postgres test covering the `__pending__` session-id flow:
 *
 *   - `claimPendingSession(agent, sessionId)` rewrites every
 *     `session_id='__pending__'` block for that agent to the SDK's
 *     real session id, and is a no-op against other agents' rows.
 *   - The updated `friday_blocks_increment_session_count` trigger
 *     (migration 0021) skips the `__pending__` sentinel on INSERT
 *     and fires on UPDATE-of-session_id so the sweep's rewrite
 *     bumps `agents.session_count` for the genuine new session.
 *   - `listAgentSessions` excludes `__pending__` so the sidebar's
 *     expand-history list doesn't render orphan sentinel rows as
 *     phantom sessions.
 *   - `listAgentSessions` returns `firstTs` / `lastTs` as real
 *     epoch-ms numbers (the `EXTRACT(EPOCH FROM ...)::bigint` fix
 *     from the same PR), not `null` (which would render as
 *     "Dec 31 1969" client-side).
 *
 * Lives next to `unread-count-trigger.test.ts` and
 * `session-count-trigger.test.ts` — same harness, same idiom:
 * stateful trigger code needs a stateful test, against real PG.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../index.js";
import { spawnTestSyncEnv } from "../test/sync-harness.js";
import * as schema from "../db/schema.js";
import {
  claimPendingSession,
  listAgentSessions,
  sessionCountsByAgent,
} from "../services/blocks.js";

let env: Awaited<ReturnType<typeof spawnTestSyncEnv>>;

beforeAll(async () => {
  env = await spawnTestSyncEnv({
    label: "pending_session_sweep",
    skipDashboard: true,
    skipDaemon: true,
    skipZeroCache: true,
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.db.truncate();
});

async function insertAgent(name: string): Promise<void> {
  const now = new Date();
  await getDb().insert(schema.agents).values({
    name,
    type: "bare",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  });
}

async function insertBlock(opts: {
  agentName: string;
  sessionId: string;
  turnId?: string;
  ts?: Date;
}): Promise<string> {
  const blockId = `blk-${Math.random().toString(36).slice(2)}`;
  await getDb()
    .insert(schema.blocks)
    .values({
      id: sql`gen_random_uuid()::text`,
      blockId,
      turnId: opts.turnId ?? `t-${Math.random().toString(36).slice(2)}`,
      agentName: opts.agentName,
      sessionId: opts.sessionId,
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "user_chat",
      contentJson: { text: "hi" },
      status: "complete",
      ts: opts.ts ?? new Date(),
    });
  return blockId;
}

async function getSessionCount(name: string): Promise<number | null> {
  const r = await getDb()
    .select({ sessionCount: schema.agents.sessionCount })
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  return r[0]?.sessionCount ?? null;
}

async function sessionIdOf(blockId: string): Promise<string | null> {
  const r = await getDb()
    .select({ sessionId: schema.blocks.sessionId })
    .from(schema.blocks)
    .where(eq(schema.blocks.blockId, blockId))
    .limit(1);
  return r[0]?.sessionId ?? null;
}

describe("claimPendingSession sweep + trigger interaction (migration 0021)", () => {
  it("rewrites every __pending__ block of the current turn and recomputes session_count", async () => {
    await insertAgent("friday");
    const b1 = await insertBlock({
      agentName: "friday",
      sessionId: "__pending__",
      turnId: "t-now",
    });
    const b2 = await insertBlock({
      agentName: "friday",
      sessionId: "__pending__",
      turnId: "t-now",
    });
    // Sentinel INSERTs must NOT bump session_count — that's the
    // migration-0021 trigger change.
    expect(await getSessionCount("friday")).toBe(0);

    const rewritten = await claimPendingSession("friday", "t-now", "sess-real");

    expect(rewritten).toBe(2);
    expect(await sessionIdOf(b1)).toBe("sess-real");
    expect(await sessionIdOf(b2)).toBe("sess-real");
    // Recomputed by the sweep — independent of trigger ordering.
    expect(await getSessionCount("friday")).toBe(1);
  });

  it("does NOT touch another TURN's __pending__ rows on the same agent (the load-bearing scope)", async () => {
    await insertAgent("friday");
    // Historical orphan from a past turn the sweep never ran for.
    const orphan = await insertBlock({
      agentName: "friday",
      sessionId: "__pending__",
      turnId: "t-yesterday",
    });
    // Current turn's __pending__ user block.
    const current = await insertBlock({
      agentName: "friday",
      sessionId: "__pending__",
      turnId: "t-today",
    });

    const rewritten = await claimPendingSession("friday", "t-today", "sess-today");

    expect(rewritten).toBe(1);
    expect(await sessionIdOf(current)).toBe("sess-today");
    // The orphan is NOT pulled into today's session — that would
    // conflate yesterday's user prompt into today's context.
    expect(await sessionIdOf(orphan)).toBe("__pending__");
    // session_count counts only the genuine session; the orphan
    // sentinel is excluded by the COUNT DISTINCT … WHERE != sentinel.
    expect(await getSessionCount("friday")).toBe(1);
  });

  it("does NOT touch another agent's __pending__ rows", async () => {
    await insertAgent("friday");
    await insertAgent("kitchen");
    const ours = await insertBlock({
      agentName: "friday",
      sessionId: "__pending__",
      turnId: "t-shared",
    });
    const theirs = await insertBlock({
      agentName: "kitchen",
      sessionId: "__pending__",
      turnId: "t-shared",
    });

    const rewritten = await claimPendingSession("friday", "t-shared", "friday-sess");

    expect(rewritten).toBe(1);
    expect(await sessionIdOf(ours)).toBe("friday-sess");
    expect(await sessionIdOf(theirs)).toBe("__pending__");
    expect(await getSessionCount("friday")).toBe(1);
    expect(await getSessionCount("kitchen")).toBe(0);
  });

  it("idempotent: a second sweep with the same turn id is a no-op", async () => {
    await insertAgent("friday");
    await insertBlock({
      agentName: "friday",
      sessionId: "__pending__",
      turnId: "t-once",
    });
    await claimPendingSession("friday", "t-once", "sess-x");
    expect(await getSessionCount("friday")).toBe(1);

    const second = await claimPendingSession("friday", "t-once", "sess-x");

    expect(second).toBe(0);
    expect(await getSessionCount("friday")).toBe(1);
  });

  it("refuses to rewrite to the sentinel itself", async () => {
    await insertAgent("friday");
    const id = await insertBlock({
      agentName: "friday",
      sessionId: "__pending__",
      turnId: "t-x",
    });

    const rewritten = await claimPendingSession("friday", "t-x", "__pending__");

    expect(rewritten).toBe(0);
    expect(await sessionIdOf(id)).toBe("__pending__");
  });

  it("INSERTing a real-session block while a __pending__ block exists counts as exactly one session", async () => {
    await insertAgent("friday");
    // Sentinel block lands first — no bump.
    await insertBlock({ agentName: "friday", sessionId: "__pending__" });
    expect(await getSessionCount("friday")).toBe(0);

    // Worker writes blocks under the real session id directly (no
    // dispatch-listener rewrite needed). Trigger bumps once on the
    // first row.
    await insertBlock({ agentName: "friday", sessionId: "sess-real" });
    await insertBlock({ agentName: "friday", sessionId: "sess-real" });

    expect(await getSessionCount("friday")).toBe(1);
  });
});

describe("listAgentSessions / sessionCountsByAgent: __pending__ + epoch math", () => {
  it("excludes the __pending__ sentinel from session summaries and counts", async () => {
    await insertAgent("friday");
    await insertBlock({ agentName: "friday", sessionId: "__pending__" });
    await insertBlock({ agentName: "friday", sessionId: "sess-1" });
    await insertBlock({ agentName: "friday", sessionId: "sess-2" });

    const sessions = await listAgentSessions("friday");
    const counts = await sessionCountsByAgent();

    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["sess-1", "sess-2"]);
    expect(counts["friday"]).toBe(2);
  });

  it("returns firstTs / lastTs as positive epoch-ms numbers, not null (the 'Dec 31' bug)", async () => {
    await insertAgent("friday");
    const before = Date.now();
    await insertBlock({
      agentName: "friday",
      sessionId: "sess-1",
      ts: new Date(before),
    });
    const later = before + 5_000;
    await insertBlock({
      agentName: "friday",
      sessionId: "sess-1",
      ts: new Date(later),
    });

    const [summary] = await listAgentSessions("friday");

    expect(summary).toBeDefined();
    expect(summary!.sessionId).toBe("sess-1");
    // The brittle prior code returned `null` here, which the client
    // turned into `new Date(0)` → "Dec 31 1969" in PST. With the
    // EXTRACT(EPOCH)*1000 fix, we get the actual millis.
    expect(Number.isFinite(summary!.firstTs)).toBe(true);
    expect(Number.isFinite(summary!.lastTs)).toBe(true);
    expect(summary!.firstTs).toBeGreaterThanOrEqual(before - 1);
    expect(summary!.firstTs).toBeLessThanOrEqual(before + 1);
    expect(summary!.lastTs).toBeGreaterThanOrEqual(later - 1);
    expect(summary!.lastTs).toBeLessThanOrEqual(later + 1);
    expect(summary!.turnCount).toBeGreaterThan(0);
  });
});
