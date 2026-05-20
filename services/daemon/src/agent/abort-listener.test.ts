/**
 * Phase 4.10 — block abortTurn LISTEN trigger tests.
 *
 * Pins the trigger contract:
 *   - Fires NOTIFY `friday_abort_requested` on UPDATE that
 *     transitions blocks.status TO 'abort_requested'.
 *   - Does NOT fire on the daemon's flip-back UPDATE to 'complete'
 *     (handler-reentry safety).
 *   - Does NOT fire on the normal user-block lifecycle (status
 *     never transitions back to 'abort_requested' from a terminal
 *     state under daemon-owned writes).
 *   - AFTER UPDATE only — INSERTs at 'abort_requested' don't fire
 *     (the mutator UPDATEs an existing user block; never INSERTs).
 *
 * The handler's full splice + flip-back behavior is covered by the
 * existing lifecycle abort tests; this file pins the trigger
 * plumbing only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDb,
  getDb,
  schema,
  type TestDbHandle,
} from "@friday/shared";
import pgPkg from "pg";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "abort_listener" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

async function insertUserBlock(
  blockId: string,
  status: string = "complete",
): Promise<void> {
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
    status,
    streaming: false,
    originMutationId: null,
    ts: new Date(),
    lastEventSeq: 0,
  });
}

describe("Postgres trigger: friday_block_abort_notify_trigger", () => {
  it("fires NOTIFY when status transitions to 'abort_requested' and carries block_id as payload", async () => {
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertUserBlock("blk-abort-1");

      const received: Array<{ channel: string; payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ channel: msg.channel, payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_abort_requested");

      const db = getDb();
      await db
        .update(schema.blocks)
        .set({ status: "abort_requested" });

      const deadline = Date.now() + 1_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(received).toHaveLength(1);
      expect(received[0]!.channel).toBe("friday_abort_requested");
      expect(received[0]!.payload).toBe("blk-abort-1");
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY when the daemon flips the row back to 'complete' (handler-reentry safety)", async () => {
    // The LISTEN handler ends with `UPDATE blocks SET status='complete'
    // WHERE block_id=...`. If the trigger fired on that flip-back too,
    // we'd loop forever (notify → handler → flip → notify → ...). The
    // trigger predicate (NEW.status='abort_requested') excludes this.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertUserBlock("blk-abort-2", "abort_requested");
      await client.query("LISTEN friday_abort_requested");
      // Drain any boot-time notification first.
      await new Promise((r) => setTimeout(r, 250));

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ payload: msg.payload ?? "" }),
      );

      const db = getDb();
      await db.update(schema.blocks).set({ status: "complete" });

      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("does NOT fire NOTIFY on common lifecycle transitions (complete → complete via other-field UPDATEs)", async () => {
    // Other field UPDATEs (e.g. `last_event_seq` advances on the
    // user block) must not spam the abort channel.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      await insertUserBlock("blk-abort-3");

      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_abort_requested");

      const db = getDb();
      await db.update(schema.blocks).set({ lastEventSeq: 42 });
      await db.update(schema.blocks).set({ blockIndex: 1 });

      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it("AFTER UPDATE only — INSERT at status='abort_requested' doesn't fire", async () => {
    // The mutator UPDATEs an existing row. INSERTs at this status
    // shouldn't happen in practice but pinning the AFTER UPDATE
    // semantic guards against accidental future code paths.
    const { Client } = pgPkg;
    const client = new Client({ connectionString: handle.databaseUrl });
    await client.connect();
    try {
      const received: Array<{ payload: string }> = [];
      client.on("notification", (msg) =>
        received.push({ payload: msg.payload ?? "" }),
      );
      await client.query("LISTEN friday_abort_requested");

      await insertUserBlock("blk-abort-insert", "abort_requested");

      await new Promise((r) => setTimeout(r, 250));
      expect(received).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
