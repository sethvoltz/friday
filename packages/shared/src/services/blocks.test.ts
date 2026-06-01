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
    });
  });

  it("updateBlock replaces content", async () => {
    const { insertBlock, updateBlock, getBlockById } = await import("./blocks.js");
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
    });
    const updated = await updateBlock("blk-svc-2", {
      contentJson: '{"text":"new"}',
      status: "complete",
    });
    expect(updated?.contentJson).toBe('{"text":"new"}');
    expect(updated?.status).toBe("complete");
    // Round-trip through the DB to verify the row really changed.
    const fetched = await getBlockById("blk-svc-2");
    expect(fetched?.contentJson).toBe('{"text":"new"}');
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

describe("getTurnAuthorUserId (PostHog per-originator attribution)", () => {
  // This is the daemon's read side of block authorship: turn_completed /
  // turn_errored fire long after the request context is gone, so the daemon
  // recovers the originating user from the turn's user block's `user_id`.
  it("returns the authoring user id from the turn's user block", async () => {
    const { insertBlock, getTurnAuthorUserId } = await import("./blocks.js");
    await insertBlock({
      blockId: "blk-turn-user",
      turnId: "t_authored",
      agentName: "friday",
      sessionId: "sess-a",
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "user_chat",
      userId: "RccSi68oUrZw4eTVmRllOtoJRsriJv4D",
      contentJson: '{"text":"hi"}',
      status: "complete",
      ts: 1000,
    });
    expect(await getTurnAuthorUserId("t_authored")).toBe("RccSi68oUrZw4eTVmRllOtoJRsriJv4D");
  });

  it("returns null for an autonomous turn (no user block carries a user_id)", async () => {
    // mail-/schedule-triggered turns: the triggering block has source≠user_chat
    // and no user_id, so the turn attributes to the service actor downstream.
    const { insertBlock, getTurnAuthorUserId } = await import("./blocks.js");
    await insertBlock({
      blockId: "blk-turn-auto",
      turnId: "t_autonomous",
      agentName: "friday",
      sessionId: "sess-b",
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "schedule",
      contentJson: '{"text":"cron task"}',
      status: "complete",
      ts: 1000,
    });
    expect(await getTurnAuthorUserId("t_autonomous")).toBeNull();
  });

  it("returns null when the turn has no blocks", async () => {
    const { getTurnAuthorUserId } = await import("./blocks.js");
    expect(await getTurnAuthorUserId("t_missing")).toBeNull();
  });

  it("picks the earliest authoring user block when several share the turn", async () => {
    const { insertBlock, getTurnAuthorUserId } = await import("./blocks.js");
    await insertBlock({
      blockId: "blk-late",
      turnId: "t_multi",
      agentName: "friday",
      sessionId: "sess-c",
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "user_chat",
      userId: "user-late",
      contentJson: '{"text":"second"}',
      status: "complete",
      ts: 2000,
    });
    await insertBlock({
      blockId: "blk-early",
      turnId: "t_multi",
      agentName: "friday",
      sessionId: "sess-c",
      blockIndex: 0,
      role: "user",
      kind: "text",
      source: "user_chat",
      userId: "user-early",
      contentJson: '{"text":"first"}',
      status: "complete",
      ts: 1000,
    });
    expect(await getTurnAuthorUserId("t_multi")).toBe("user-early");
  });
});
