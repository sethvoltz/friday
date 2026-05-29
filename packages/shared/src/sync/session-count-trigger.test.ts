/**
 * End-to-end Postgres test for `friday_blocks_increment_session_count_trigger`
 * (migration 0020). Runs against a real scratch database via the shared
 * sync-harness — no trigger mocking.
 *
 * Mirrors the discipline of `unread-count-trigger.test.ts`: stateful code
 * (trigger maintaining a derived count) needs a stateful test. Pure
 * unit tests of `/clear` (or anywhere else that mints fresh sessions)
 * verify the JS side; they don't observe the trigger fire on block
 * INSERT, the novel-vs-existing predicate, or the cross-agent isolation
 * the sidebar depends on.
 *
 * What this pins:
 *   - First block in a never-seen (agent, session_id) pair bumps
 *     `agents.session_count` by 1.
 *   - Subsequent blocks in the same (agent, session_id) pair are no-ops.
 *   - A second distinct session_id for the same agent bumps to 2 —
 *     this is the gate behind the sidebar's "show + button" condition.
 *   - Cross-agent isolation: agent A's insert never touches agent B's
 *     session_count.
 *   - Missing agent row → the trigger's UPDATE matches 0 rows but the
 *     block INSERT itself still succeeds.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../index.js";
import { spawnTestSyncEnv } from "../test/sync-harness.js";
import * as schema from "../db/schema.js";

let env: Awaited<ReturnType<typeof spawnTestSyncEnv>>;

beforeAll(async () => {
  env = await spawnTestSyncEnv({
    label: "session_count_trigger",
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

async function insertBlock(opts: { agentName: string; sessionId: string }): Promise<void> {
  await getDb()
    .insert(schema.blocks)
    .values({
      id: sql`gen_random_uuid()::text`,
      blockId: `blk-${Math.random().toString(36).slice(2)}`,
      turnId: `t-${Math.random().toString(36).slice(2)}`,
      agentName: opts.agentName,
      sessionId: opts.sessionId,
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      source: null,
      contentJson: { text: "" },
      status: "complete",
      ts: new Date(),
    });
}

async function getSessionCount(name: string): Promise<number | null> {
  const r = await getDb()
    .select({ sessionCount: schema.agents.sessionCount })
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  return r[0]?.sessionCount ?? null;
}

describe("friday_blocks_increment_session_count_trigger (migration 0020)", () => {
  it("bumps session_count from 0 to 1 on the first block of a fresh session", async () => {
    await insertAgent("friday");
    expect(await getSessionCount("friday")).toBe(0);

    await insertBlock({ agentName: "friday", sessionId: "sess-1" });

    expect(await getSessionCount("friday")).toBe(1);
  });

  it("does NOT re-bump when subsequent blocks land on an already-seen session_id", async () => {
    await insertAgent("friday");
    await insertBlock({ agentName: "friday", sessionId: "sess-1" });
    await insertBlock({ agentName: "friday", sessionId: "sess-1" });
    await insertBlock({ agentName: "friday", sessionId: "sess-1" });

    expect(await getSessionCount("friday")).toBe(1);
  });

  it("bumps to 2 when a brand-new session_id appears for the same agent (the sidebar + button gate)", async () => {
    await insertAgent("friday");
    await insertBlock({ agentName: "friday", sessionId: "sess-1" });
    expect(await getSessionCount("friday")).toBe(1);

    await insertBlock({ agentName: "friday", sessionId: "sess-2" });
    expect(await getSessionCount("friday")).toBe(2);
  });

  it("keeps cross-agent counts isolated — agent A's insert never touches agent B", async () => {
    await insertAgent("friday");
    await insertAgent("linear-import");

    await insertBlock({ agentName: "friday", sessionId: "sess-1" });
    await insertBlock({ agentName: "friday", sessionId: "sess-2" });
    await insertBlock({ agentName: "linear-import", sessionId: "sess-X" });

    expect(await getSessionCount("friday")).toBe(2);
    expect(await getSessionCount("linear-import")).toBe(1);
  });

  it("alternating inserts across two sessions still arrive at the right count", async () => {
    await insertAgent("friday");
    await insertBlock({ agentName: "friday", sessionId: "sess-1" });
    await insertBlock({ agentName: "friday", sessionId: "sess-2" });
    await insertBlock({ agentName: "friday", sessionId: "sess-1" });
    await insertBlock({ agentName: "friday", sessionId: "sess-2" });
    await insertBlock({ agentName: "friday", sessionId: "sess-1" });

    expect(await getSessionCount("friday")).toBe(2);
  });

  it("no agent row → block INSERT still succeeds; UPDATE matches 0 rows", async () => {
    await expect(insertBlock({ agentName: "friday", sessionId: "sess-1" })).resolves.not.toThrow();
    expect(await getSessionCount("friday")).toBeNull();
  });
});
