/**
 * Phase 4.9 — block cancelQueued LISTEN trigger tests.
 *
 * Pins the trigger contract:
 *   - Fires NOTIFY `friday_block_canceled` on UPDATE that transitions
 *     blocks.status TO 'cancel_requested' (the mutator's write).
 *   - Does NOT fire on the daemon's DELETE (DELETE doesn't fire
 *     AFTER UPDATE — handler-reentry safety).
 *   - Does NOT fire on common queued → dispatched / aborted lifecycle
 *     transitions.
 *   - AFTER UPDATE only — INSERTs at 'cancel_requested' don't fire
 *     (legacy paths never INSERT at this status; the new mutator
 *     never INSERTs blocks at all).
 *   - blocks.status check constraint accepts 'cancel_requested'.
 *
 * The handler's full splice + DELETE behavior is covered by the
 * existing lifecycle / REST-cancel tests; this file pins the
 * trigger plumbing only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  getDb,
  schema,
  type TestDbHandle,
} from "@friday/shared";
import pgPkg from "pg";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "cancel_listener" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

async function insertQueuedBlock(blockId: string): Promise<void> {
  const db = getDb();
  await db.insert(schema.blocks).values({
    blockId,
    turnId: `turn-${blockId}`,
    agentName: "test-agent",
    sessionId: "test-session",
    messageId: null,
    blockIndex: 0,
    role: "user",
    kind: "text",
    source: "user_chat",
    contentJson: { text: "hello" },
    status: "queued",
    streaming: false,
    originMutationId: null,
    ts: new Date(),
    lastEventSeq: 0,
  });
}

describe("Postgres trigger: friday_block_cancel_notify_trigger", () => {
  it("fires NOTIFY when status transitions to 'cancel_requested' and carries block_id as payload", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertQueuedBlock("blk-cancel-1");

      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ channel: msg.channel, payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_block_canceled");

      const db = getDb();
      await db
        .update(schema.blocks)
        .set({ status: "cancel_requested" });

      await vi.waitFor(
        () => {
          expect(received).toHaveLength(1);
          expect(received[0]!.channel).toBe("friday_block_canceled");
          expect(received[0]!.payload).toBe("blk-cancel-1");
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY on DELETE (handler-reentry safety: trigger is AFTER UPDATE only)", async () => {
    // The daemon's LISTEN handler ends with `deleteBlockById(blockId)`.
    // If the trigger fired on DELETE too, the handler would loop
    // (DELETE → NOTIFY → handler → DELETE → NOTIFY → …). Since the
    // trigger is AFTER UPDATE, the row's DELETE is silent — verified
    // here by flipping to 'cancel_requested' (which fires once), then
    // DELETING the row and observing that no additional notification
    // arrives.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertQueuedBlock("blk-cancel-2");
      await client.query("LISTEN friday_block_canceled");
      // negative-space: drain the cancel_requested NOTIFY before attaching
      // our handler so the assertion below isn't polluted.
      const db = getDb();
      await db
        .update(schema.blocks)
        .set({ status: "cancel_requested" });
      await new Promise((r) => setTimeout(r, 250));

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ payload: msg.payload ?? "" }),
      );

      await db.delete(schema.blocks);

      // negative-space: trigger is AFTER UPDATE only — DELETEs don't fire.
      // A bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY on queued → dispatched / complete transitions", async () => {
    // Normal worker lifecycle UPDATEs to a queued block (dispatch +
    // completion) must not spam the cancel channel.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertQueuedBlock("blk-cancel-3");

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_block_canceled");

      const db = getDb();
      await db.update(schema.blocks).set({ status: "dispatched" });
      await db.update(schema.blocks).set({ status: "complete" });

      // negative-space: trigger predicate fires only on transitions to
      // 'cancel_requested' — a bounded real-time wait confirms no
      // spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("AFTER UPDATE only — INSERT at status='cancel_requested' doesn't fire", async () => {
    // The mutator UPDATEs an existing row (the queued user block was
    // INSERTed earlier by `recordUserBlock`); it never INSERTs at
    // cancel_requested directly. Pin AFTER UPDATE semantics here.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_block_canceled");

      const db = getDb();
      await db.insert(schema.blocks).values({
        blockId: "blk-cancel-insert",
        turnId: "turn-insert",
        agentName: "test-agent",
        sessionId: "test-session",
        messageId: null,
        blockIndex: 0,
        role: "user",
        kind: "text",
        source: "user_chat",
        contentJson: { text: "x" },
        status: "cancel_requested",
        streaming: false,
        originMutationId: null,
        ts: new Date(),
        lastEventSeq: 0,
      });

      // negative-space: trigger is AFTER UPDATE only — INSERTs don't fire.
      // A bounded real-time wait confirms no spurious NOTIFY arrives.
      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});

describe("blocks status enum + cancel_requested", () => {
  it("accepts 'cancel_requested' as a valid status value", async () => {
    // Migration 0008 extends the check constraint. If we forgot to
    // update the constraint when adding the status, this INSERT
    // would fail with a CHECK violation.
    const db = getDb();
    await db.insert(schema.blocks).values({
      blockId: "blk-status-enum",
      turnId: "turn-enum",
      agentName: "x",
      sessionId: "s",
      messageId: null,
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "user_chat",
      contentJson: { text: "x" },
      status: "cancel_requested",
      streaming: false,
      originMutationId: null,
      ts: new Date(),
      lastEventSeq: 0,
    });
    const rows = await db
      .select({ status: schema.blocks.status })
      .from(schema.blocks);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("cancel_requested");
  });
});
