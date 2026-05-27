/**
 * Phase 4.11b — sendUserMessage LISTEN trigger tests.
 *
 * Pins the trigger contract:
 *   - Fires NOTIFY `friday_new_pending_block` on INSERT at
 *     status='pending' with the row's id as payload.
 *   - Does NOT fire on the daemon's UPDATE flip-back to
 *     'complete' / 'queued' (handler-reentry safety: trigger is
 *     AFTER INSERT only, not AFTER UPDATE).
 *   - Does NOT fire on INSERTs at any non-'pending' status
 *     (recordUserBlock writes 'complete' or 'queued' directly —
 *     those legacy paths must not re-enter the dispatch handler).
 *
 * The handler's full dispatch (agent register, prompt compose,
 * skill match, recall wrap, dispatchTurn) is exercised by the
 * existing chat-turn integration tests; this file pins the
 * trigger plumbing only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";
import pgPkg from "pg";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "dispatch_listener" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

async function insertBlock(id: string, status: string): Promise<void> {
  const db = getDb();
  await db.insert(schema.blocks).values({
    id,
    blockId: id,
    turnId: `t_${id}`,
    agentName: "test-agent",
    sessionId: "__pending__",
    messageId: null,
    blockIndex: 0,
    role: "user",
    kind: "text",
    source: "user_chat",
    contentJson: { text: "hello" },
    status,
    streaming: false,
    originMutationId: null,
    ts: new Date(),
    lastEventSeq: 0,
  });
}

describe("Postgres trigger: friday_block_dispatch_notify_trigger", () => {
  it("fires NOTIFY on INSERT at status='pending' with the row id as payload", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ channel: msg.channel, payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_new_pending_block");

      await insertBlock("blk-dispatch-1", "pending");

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.channel).toBe("friday_new_pending_block");
          expect(received[0]!.payload).toBe("blk-dispatch-1");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("does NOT fire on INSERT at status='complete' (legacy recordUserBlock path)", async () => {
    // The legacy `POST /api/chat/turn` writes 'complete' (or
    // 'queued') directly via `recordUserBlock`; those rows must
    // not re-enter the LISTEN handler.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_new_pending_block");

      await insertBlock("blk-dispatch-2", "complete");

      // negative-space: the trigger predicate excludes non-'pending' INSERTs —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire on INSERT at status='queued' (legacy queued path)", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));
      await client.query("LISTEN friday_new_pending_block");

      await insertBlock("blk-dispatch-3", "queued");

      // negative-space: the trigger predicate excludes non-'pending' INSERTs —
      // a bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire on UPDATE pending → complete (handler-reentry safety: AFTER INSERT only)", async () => {
    // The LISTEN handler ends with `UPDATE blocks SET
    // status='complete'`. If the trigger fired on UPDATEs too,
    // we'd loop (notify → handler → flip → notify → ...). The
    // trigger is AFTER INSERT only.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertBlock("blk-dispatch-4", "pending");
      await client.query("LISTEN friday_new_pending_block");
      // negative-space: drain the pending-INSERT NOTIFY before attaching
      // our handler so the assertion below isn't polluted.
      await new Promise((r) => setTimeout(r, 250));

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));

      const db = getDb();
      await db.update(schema.blocks).set({ status: "complete" });

      // negative-space: trigger is AFTER INSERT only — UPDATEs don't fire.
      // A bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire on UPDATE pending → queued (worker-mid-turn path)", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertBlock("blk-dispatch-5", "pending");
      await client.query("LISTEN friday_new_pending_block");
      // negative-space: drain the pending-INSERT NOTIFY before attaching
      // our handler so the assertion below isn't polluted.
      await new Promise((r) => setTimeout(r, 250));

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) => received.push({ payload: msg.payload ?? "" }));

      const db = getDb();
      await db.update(schema.blocks).set({ status: "queued" });

      // negative-space: trigger is AFTER INSERT only — UPDATEs don't fire.
      // A bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
