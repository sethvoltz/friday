/**
 * End-to-end Postgres test for the `friday_blocks_increment_unread_trigger`
 * shipped in migration 0016 (item #52). Runs against a real scratch
 * database via the shared sync-harness — no mocks of the trigger itself.
 *
 * This is the test discipline the global CLAUDE.md called out:
 * "stateful code needs stateful tests." The unread-count badge is
 * driven by a Postgres trigger; a pure unit test of `markRead` only
 * verifies the JS-side reset, not the trigger fire on block INSERT.
 * Running against a real PG round-trip catches:
 *   - The predicate gate (role='assistant' OR specific user sources).
 *   - The cross-agent isolation (an INSERT on agent A doesn't bump
 *     agent B's cursor).
 *   - The cross-device fan-out (every device's cursor for the agent
 *     gets bumped by a single block).
 *   - The markRead reset (UPDATE atomically clears unread_count).
 *
 * Lives in `packages/shared` because that's where the trigger SQL
 * lives. The daemon's tests can layer mutator-driven scenarios on
 * top once the harness's subprocess piece is built (see
 * `sync-harness.ts` for the scope note).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../index.js";
import { spawnTestSyncEnv } from "../test/sync-harness.js";
import * as schema from "../db/schema.js";

// Loose env shape — the trigger tests only need databaseUrl, db, and
// cleanup. Skip the multi-subprocess parts for speed (this is a pure
// SQL test against the migration's trigger code).
let env: Awaited<ReturnType<typeof spawnTestSyncEnv>>;

beforeAll(async () => {
  env = await spawnTestSyncEnv({
    label: "unread_trigger",
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

async function insertCursor(
  deviceId: string,
  agentName: string,
  lastSeenBlockId = "blk-init",
  unreadCount = 0,
): Promise<void> {
  await getDb()
    .insert(schema.readCursors)
    .values({
      deviceId,
      agentName,
      lastSeenBlockId,
      ts: new Date(),
      unreadCount,
    });
}

async function getCursor(
  deviceId: string,
  agentName: string,
): Promise<{ unreadCount: number; lastSeenBlockId: string } | null> {
  const r = await getDb()
    .select({
      unreadCount: schema.readCursors.unreadCount,
      lastSeenBlockId: schema.readCursors.lastSeenBlockId,
    })
    .from(schema.readCursors)
    .where(
      and(
        eq(schema.readCursors.deviceId, deviceId),
        eq(schema.readCursors.agentName, agentName),
      ),
    )
    .limit(1);
  return r[0] ?? null;
}

async function insertBlock(opts: {
  agentName: string;
  role: "assistant" | "user";
  source?: string | null;
}): Promise<void> {
  await getDb()
    .insert(schema.blocks)
    .values({
      id: sql`gen_random_uuid()::text`,
      blockId: `blk-${Math.random().toString(36).slice(2)}`,
      turnId: `t-${Math.random().toString(36).slice(2)}`,
      agentName: opts.agentName,
      sessionId: "test-session",
      blockIndex: 0,
      role: opts.role,
      kind: "text",
      source: opts.source ?? null,
      contentJson: { text: "" },
      status: "complete",
      ts: new Date(),
      lastEventSeq: 0,
    });
}

describe("friday_blocks_increment_unread_trigger (item #52 — end-to-end PG)", () => {
  it("increments unread_count on assistant block INSERT for every matching read_cursors row", async () => {
    await insertCursor("dev-1", "friday", "blk-init", 0);
    await insertCursor("dev-2", "friday", "blk-init", 0);
    // Cross-agent: this cursor must NOT increment.
    await insertCursor("dev-1", "linear-import", "blk-init", 0);

    await insertBlock({ agentName: "friday", role: "assistant" });

    const f1 = await getCursor("dev-1", "friday");
    const f2 = await getCursor("dev-2", "friday");
    const other = await getCursor("dev-1", "linear-import");

    expect(f1?.unreadCount).toBe(1);
    expect(f2?.unreadCount).toBe(1);
    expect(other?.unreadCount).toBe(0);
  });

  it("does NOT increment on a user-authored block (user typed it; not someone else)", async () => {
    await insertCursor("dev-1", "friday", "blk-init", 0);
    await insertBlock({ agentName: "friday", role: "user", source: "user_chat" });
    const c = await getCursor("dev-1", "friday");
    expect(c?.unreadCount).toBe(0);
  });

  it("DOES increment on a mail-source user block (agent-driven traffic, not the user typing)", async () => {
    await insertCursor("dev-1", "friday", "blk-init", 0);
    await insertBlock({ agentName: "friday", role: "user", source: "mail" });
    const c = await getCursor("dev-1", "friday");
    expect(c?.unreadCount).toBe(1);
  });

  it("accumulates across multiple assistant blocks until reset", async () => {
    await insertCursor("dev-1", "friday", "blk-init", 0);
    await insertBlock({ agentName: "friday", role: "assistant" });
    await insertBlock({ agentName: "friday", role: "assistant" });
    await insertBlock({ agentName: "friday", role: "assistant" });
    const c = await getCursor("dev-1", "friday");
    expect(c?.unreadCount).toBe(3);
  });

  it("UPSERT with unread_count=0 resets atomically (markRead semantics)", async () => {
    await insertCursor("dev-1", "friday", "blk-init", 0);
    await insertBlock({ agentName: "friday", role: "assistant" });
    await insertBlock({ agentName: "friday", role: "assistant" });
    let c = await getCursor("dev-1", "friday");
    expect(c?.unreadCount).toBe(2);

    // Mutator-equivalent UPSERT.
    await getDb()
      .insert(schema.readCursors)
      .values({
        deviceId: "dev-1",
        agentName: "friday",
        lastSeenBlockId: "blk-newest",
        ts: new Date(),
        unreadCount: 0,
      })
      .onConflictDoUpdate({
        target: [schema.readCursors.deviceId, schema.readCursors.agentName],
        set: { lastSeenBlockId: "blk-newest", unreadCount: 0 },
      });

    c = await getCursor("dev-1", "friday");
    expect(c?.unreadCount).toBe(0);
    expect(c?.lastSeenBlockId).toBe("blk-newest");

    // Subsequent INSERT bumps from the reset baseline.
    await insertBlock({ agentName: "friday", role: "assistant" });
    c = await getCursor("dev-1", "friday");
    expect(c?.unreadCount).toBe(1);
  });

  it("no cursor row → INSERT is a no-op (no fan-out to non-existent rows)", async () => {
    // Empty read_cursors table; the trigger's UPDATE WHERE matches 0 rows.
    // The block INSERT itself must succeed cleanly.
    await expect(
      insertBlock({ agentName: "friday", role: "assistant" }),
    ).resolves.not.toThrow();
    const c = await getCursor("dev-1", "friday");
    expect(c).toBeNull();
  });
});
