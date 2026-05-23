/**
 * Phase 4.9 — POST /api/internal/cancel-queued fast-path contract tests.
 *
 * The endpoint splices the worker's in-memory `nextPrompts` deque
 * synchronously and returns the recovered prompt text so the
 * dashboard can stuff it back into the input bar.
 *
 * Idempotency contract (plan §5): the fast-path MUST be idempotent
 * against the LISTEN-path (the mutator's UPDATE → trigger → DELETE
 * sequence). When the LISTEN-path wins the race and DELETEs the row
 * first, the fast-path returns 200 with `already_canceled=true` and
 * `text=""`.
 *
 * The trigger / LISTEN handler is covered by `cancel-listener.test.ts`;
 * this file pins the fast-path's HTTP contract + idempotency against
 * row-already-gone.
 */

import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle, getDb, schema } from "@friday/shared";
import { eq } from "drizzle-orm";

let handle: TestDbHandle;
let server: Server;
let port: number;

beforeAll(async () => {
  handle = await createTestDb({ label: "cancel_fastpath" });
  const { startServer } = await import("./server.js");
  server = startServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port assigned");
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

function url(): string {
  return `http://127.0.0.1:${port}/api/internal/cancel-queued`;
}

async function insertQueuedBlock(blockId: string, text: string): Promise<void> {
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
    contentJson: { text },
    status: "queued",
    streaming: false,
    originMutationId: null,
    ts: new Date(),
    lastEventSeq: 0,
  });
}

describe("POST /api/internal/cancel-queued (Phase 4.9 fast-path)", () => {
  it("returns 400 when block_id is missing", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_block_id");
  });

  it("returns recovered prompt text when the row exists at status='queued'", async () => {
    await insertQueuedBlock("blk-fast-1", "the original prompt");
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ block_id: "blk-fast-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      already_canceled: boolean;
      text: string;
      turn_id: string;
      agent: string;
    };
    expect(body.ok).toBe(true);
    expect(body.text).toBe("the original prompt");
    expect(body.turn_id).toBe("turn-blk-fast-1");
    expect(body.agent).toBe("test-agent");
    // The fast-path does NOT delete the row — that's the LISTEN-path's
    // job (so the AFTER UPDATE trigger has something to fire on).
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.blockId, "blk-fast-1"));
    expect(rows).toHaveLength(1);
  });

  it("is idempotent — returns already_canceled=true with empty text when row already DELETEd by LISTEN-path", async () => {
    // Simulate the LISTEN-path winning: row was already deleted before
    // the dashboard's HTTP fast-path arrived (e.g. another tab cancelled
    // and the trigger fired faster than this tab's POST).
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ block_id: "blk-already-gone" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      already_canceled: boolean;
      text: string;
    };
    expect(body.ok).toBe(true);
    expect(body.already_canceled).toBe(true);
    expect(body.text).toBe("");
  });

  it("returns 409 when the block has already dispatched (status='dispatched')", async () => {
    const db = getDb();
    await db.insert(schema.blocks).values({
      blockId: "blk-dispatched",
      turnId: "turn-dispatched",
      agentName: "test-agent",
      sessionId: "test-session",
      messageId: null,
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "user_chat",
      contentJson: { text: "x" },
      status: "dispatched",
      streaming: false,
      originMutationId: null,
      ts: new Date(),
      lastEventSeq: 0,
    });
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ block_id: "blk-dispatched" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; status: string };
    expect(body.error).toBe("not_queued");
    expect(body.status).toBe("dispatched");
  });

  it("accepts status='cancel_requested' (idempotent against the mutator-path racing first)", async () => {
    // The mutator UPDATEs status='cancel_requested' before the LISTEN
    // handler DELETEs the row. If the fast-path arrives in that gap,
    // the row exists with the new status — we MUST still treat it as
    // cancellable (already in flight, the splice still needs to happen
    // in case the worker's deque still has the entry).
    const db = getDb();
    await db.insert(schema.blocks).values({
      blockId: "blk-mid-flight",
      turnId: "turn-mid",
      agentName: "test-agent",
      sessionId: "test-session",
      messageId: null,
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "user_chat",
      contentJson: { text: "midflight prompt" },
      status: "cancel_requested",
      streaming: false,
      originMutationId: null,
      ts: new Date(),
      lastEventSeq: 0,
    });
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ block_id: "blk-mid-flight" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };
    expect(body.text).toBe("midflight prompt");
  });
});
