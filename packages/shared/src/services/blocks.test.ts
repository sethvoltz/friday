import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "../db/test-pg.js";

// Per ADR-023, tests run against a per-file Postgres scratch DB. The
// harness sets DATABASE_URL and resets the client singleton before any
// service module under test imports it. We `await import(...)` the
// modules so the dynamic import binds to the post-handle env.
let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "blocks_svc" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("blocks service (FIX_FORWARD 1.2)", () => {
  it("insertBlock persists every field, retrievable by getBlockById", async () => {
    const { insertBlock, getBlockById } = await import("./blocks.js");
    await insertBlock({
      blockId: "blk-svc-1",
      turnId: "turn-svc-1",
      agentName: "alpha",
      sessionId: "sess-1",
      messageId: "msg-1",
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      source: null,
      contentJson: '{"text":"hello"}',
      status: "streaming",
      ts: 1000,
      lastEventSeq: 1,
    });

    // Load-bearing: this verifies the column mapping is correct end-to-end.
    const fetched = await getBlockById("blk-svc-1");
    expect(fetched).toMatchObject({
      blockId: "blk-svc-1",
      turnId: "turn-svc-1",
      agentName: "alpha",
      sessionId: "sess-1",
      messageId: "msg-1",
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      source: null,
      contentJson: '{"text":"hello"}',
      status: "streaming",
      ts: 1000,
      lastEventSeq: 1,
    });
  });

  it("updateBlock replaces content and bumps last_event_seq", async () => {
    const { insertBlock, updateBlock, getBlockById } = await import(
      "./blocks.js"
    );
    await insertBlock({
      blockId: "blk-svc-2",
      turnId: "turn-1",
      agentName: "alpha",
      sessionId: "sess-1",
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      contentJson: '{"text":"old"}',
      status: "streaming",
      ts: 1000,
      lastEventSeq: 1,
    });
    const updated = await updateBlock("blk-svc-2", {
      contentJson: '{"text":"new"}',
      status: "complete",
      lastEventSeq: 5,
    });
    expect(updated?.contentJson).toBe('{"text":"new"}');
    expect(updated?.status).toBe("complete");
    expect(updated?.lastEventSeq).toBe(5);
    // Round-trip through the DB to verify the row really changed.
    const fetched = await getBlockById("blk-svc-2");
    expect(fetched?.contentJson).toBe('{"text":"new"}');
    expect(fetched?.lastEventSeq).toBe(5);
  });

  it("updateBlock returns null for an unknown blockId", async () => {
    const { updateBlock } = await import("./blocks.js");
    const result = await updateBlock("nonexistent", { status: "complete" });
    expect(result).toBeNull();
  });

  it("listBlocks filters by agent and respects limit/order", async () => {
    const { insertBlock, listBlocks } = await import("./blocks.js");
    // Two agents, three rows each, distinct timestamps so DESC ordering
    // pins to ts.
    for (const agent of ["alpha", "beta"]) {
      for (let i = 0; i < 3; i++) {
        await insertBlock({
          blockId: `blk-${agent}-${i}`,
          turnId: `turn-${agent}-${i}`,
          agentName: agent,
          sessionId: `sess-${agent}`,
          blockIndex: 0,
          role: "assistant",
          kind: "text",
          contentJson: `{"text":"${agent} ${i}"}`,
          status: "complete",
          ts: 1000 + i,
          lastEventSeq: i + 1,
        });
      }
    }
    const alphaRows = await listBlocks({ agentName: "alpha" });
    expect(alphaRows.length).toBe(3);
    expect(alphaRows.every((r) => r.agentName === "alpha")).toBe(true);
    // Default order is DESC by id, which for sequential inserts means
    // most-recently-inserted first.
    expect(alphaRows[0].blockId).toBe("blk-alpha-2");
    expect(alphaRows[2].blockId).toBe("blk-alpha-0");

    const limited = await listBlocks({ agentName: "alpha", limit: 1 });
    expect(limited.length).toBe(1);
    expect(limited[0].blockId).toBe("blk-alpha-2");
  });
});
