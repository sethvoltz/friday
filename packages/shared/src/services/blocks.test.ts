import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Drive the blocks service against an in-memory DB by replacing the client
// module the service imports.

let raw: Database.Database;

vi.mock("../db/client.js", async () => {
  const drizzleMod = await import("drizzle-orm/better-sqlite3");
  const schema = await import("../db/schema.js");
  return {
    getRawDb: () => raw,
    getDb: () => drizzleMod.drizzle(raw, { schema }),
    closeDb: () => {
      raw.close();
    },
  };
});

beforeEach(async () => {
  raw = new Database(":memory:");
  raw.pragma("journal_mode = MEMORY");
  raw.pragma("foreign_keys = ON");
  const { runMigrations } = await import("../db/migrate.js");
  runMigrations();
});

afterEach(() => {
  raw.close();
});

describe("blocks service (FIX_FORWARD 1.2)", () => {
  it("insertBlock persists every field, retrievable by getBlockById", async () => {
    const { insertBlock, getBlockById } = await import("./blocks.js");
    insertBlock({
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
    // A regression that drops a field or maps it to the wrong column
    // surfaces here. `id` is the autoincrement PK so we match it loosely.
    const fetched = getBlockById("blk-svc-1");
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
    const { insertBlock, updateBlock, getBlockById } = await import("./blocks.js");
    insertBlock({
      blockId: "blk-svc-2",
      turnId: "turn-1",
      agentName: "alpha",
      sessionId: "sess-1",
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      contentJson: "",
      status: "streaming",
      ts: 1000,
      lastEventSeq: 1,
    });

    const updated = updateBlock("blk-svc-2", {
      contentJson: '{"text":"hello world"}',
      status: "complete",
      lastEventSeq: 5,
      ts: 2000,
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("complete");
    expect(updated!.lastEventSeq).toBe(5);

    const fetched = getBlockById("blk-svc-2");
    expect(fetched!.contentJson).toBe('{"text":"hello world"}');
    expect(fetched!.ts).toBe(2000);
  });

  it("updateBlock returns null for an unknown blockId", async () => {
    const { updateBlock } = await import("./blocks.js");
    expect(updateBlock("nonexistent", { status: "complete" })).toBeNull();
  });

  it("listBlocks filters by agent and respects limit/order", async () => {
    const { insertBlock, listBlocks } = await import("./blocks.js");
    for (let i = 0; i < 5; i++) {
      insertBlock({
        blockId: `blk-list-${i}`,
        turnId: "turn-1",
        agentName: i % 2 === 0 ? "alpha" : "beta",
        sessionId: "sess-1",
        blockIndex: i,
        role: "assistant",
        kind: "text",
        contentJson: `{"text":"hello-${i}"}`,
        status: "complete",
        ts: 1000 + i,
        lastEventSeq: i + 1,
      });
    }

    const alphaDesc = listBlocks({ agentName: "alpha", limit: 10 });
    expect(alphaDesc.map((r) => r.blockId)).toEqual([
      "blk-list-4",
      "blk-list-2",
      "blk-list-0",
    ]);

    const alphaAsc = listBlocks({
      agentName: "alpha",
      limit: 10,
      ascending: true,
    });
    expect(alphaAsc.map((r) => r.blockId)).toEqual([
      "blk-list-0",
      "blk-list-2",
      "blk-list-4",
    ]);

    const beforeId = alphaDesc[0].id;
    const older = listBlocks({
      agentName: "alpha",
      beforeId,
      limit: 10,
    });
    expect(older.map((r) => r.blockId)).toEqual([
      "blk-list-2",
      "blk-list-0",
    ]);
  });

  it("maxSeqByAgent returns 0 for empty agent, max seq otherwise", async () => {
    const { insertBlock, maxSeqByAgent } = await import("./blocks.js");
    expect(maxSeqByAgent("nobody")).toBe(0);

    insertBlock({
      blockId: "blk-seq-1",
      turnId: "turn-1",
      agentName: "alpha",
      sessionId: "sess-1",
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      contentJson: "{}",
      status: "complete",
      ts: 1,
      lastEventSeq: 3,
    });
    insertBlock({
      blockId: "blk-seq-2",
      turnId: "turn-1",
      agentName: "alpha",
      sessionId: "sess-1",
      blockIndex: 1,
      role: "assistant",
      kind: "text",
      contentJson: "{}",
      status: "complete",
      ts: 2,
      lastEventSeq: 7,
    });
    expect(maxSeqByAgent("alpha")).toBe(7);
  });

  it("fetchBlocksByAgent default mode returns most-recent N in desc order", async () => {
    const { insertBlock, fetchBlocksByAgent } = await import("./blocks.js");
    for (let i = 0; i < 5; i++) {
      insertBlock({
        blockId: `blk-fb-${i}`,
        turnId: "turn-1",
        agentName: "alpha",
        sessionId: "sess-1",
        blockIndex: i,
        role: "assistant",
        kind: "text",
        contentJson: `{"text":"hi-${i}"}`,
        status: "complete",
        ts: 100 + i,
        lastEventSeq: i + 1,
      });
    }
    const r = fetchBlocksByAgent({ agentName: "alpha", limit: 3 });
    expect(r.blocks.map((b) => b.blockId)).toEqual([
      "blk-fb-4",
      "blk-fb-3",
      "blk-fb-2",
    ]);
    expect(r.lastEventSeq).toBe(5);
  });

  it("fetchBlocksByAgent clamps limit to MAX_LIMIT (200)", async () => {
    const { insertBlock, fetchBlocksByAgent } = await import("./blocks.js");
    // Insert 250 rows so the cap actually matters. Using batch sql here
    // (insertBlock per-row is fine but 250 is enough that explicit-loop
    // readability beats further factoring).
    for (let i = 0; i < 250; i++) {
      insertBlock({
        blockId: `blk-cap-${i.toString().padStart(3, "0")}`,
        turnId: "turn-cap",
        agentName: "alpha",
        sessionId: "sess-cap",
        blockIndex: i,
        role: "assistant",
        kind: "text",
        contentJson: "{}",
        status: "complete",
        ts: 1000 + i,
        lastEventSeq: i + 1,
      });
    }
    const r = fetchBlocksByAgent({ agentName: "alpha", limit: 1000 });
    // The cap is the load-bearing claim. The newest row (`blk-cap-249`)
    // must be first; the 200th in the returned list is `blk-cap-050`
    // (250 - 200 = 50). If the regression returns 250, the boundary
    // check fails.
    expect(r.blocks.length).toBe(200);
    expect(r.blocks[0]!.blockId).toBe("blk-cap-249");
    expect(r.blocks[199]!.blockId).toBe("blk-cap-050");
  });

  it("fetchBlocksByAgent before/after paginates by block_id cursor", async () => {
    const { insertBlock, fetchBlocksByAgent } = await import("./blocks.js");
    for (let i = 0; i < 5; i++) {
      insertBlock({
        blockId: `blk-page-${i}`,
        turnId: "turn-1",
        agentName: "alpha",
        sessionId: "sess-1",
        blockIndex: i,
        role: "assistant",
        kind: "text",
        contentJson: `{"text":"page-${i}"}`,
        status: "complete",
        ts: 200 + i,
        lastEventSeq: i + 1,
      });
    }
    // Anchor on the middle block.
    const anchorBefore = fetchBlocksByAgent({
      agentName: "alpha",
      beforeBlockId: "blk-page-2",
      limit: 10,
    });
    expect(anchorBefore.blocks.map((b) => b.blockId)).toEqual([
      "blk-page-1",
      "blk-page-0",
    ]);

    const anchorAfter = fetchBlocksByAgent({
      agentName: "alpha",
      afterBlockId: "blk-page-2",
      limit: 10,
    });
    expect(anchorAfter.blocks.map((b) => b.blockId)).toEqual([
      "blk-page-3",
      "blk-page-4",
    ]);
  });

  it("fetchBlocksByAgent around_ts returns blocks chronologically across a target", async () => {
    const { insertBlock, fetchBlocksByAgent } = await import("./blocks.js");
    const tsList = [1000, 1100, 1200, 1300, 1400, 1500, 1600];
    tsList.forEach((ts, i) => {
      insertBlock({
        blockId: `blk-ts-${i}`,
        turnId: "turn-1",
        agentName: "alpha",
        sessionId: "sess-1",
        blockIndex: i,
        role: "assistant",
        kind: "text",
        contentJson: `{"text":"ts-${ts}"}`,
        status: "complete",
        ts,
        lastEventSeq: i + 1,
      });
    });
    const r = fetchBlocksByAgent({
      agentName: "alpha",
      aroundTs: 1300,
      beforeLimit: 2,
      afterLimit: 2,
    });
    expect(r.blocks.map((b) => b.blockId)).toEqual([
      "blk-ts-1",
      "blk-ts-2",
      "blk-ts-3",
      "blk-ts-4",
    ]);
  });

  it("fetchBlocksByAgent match mode delegates to FTS and respects limit", async () => {
    const { insertBlock, fetchBlocksByAgent } = await import("./blocks.js");
    insertBlock({
      blockId: "blk-match-1",
      turnId: "turn-1",
      agentName: "alpha",
      sessionId: "sess-1",
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      contentJson: '{"text":"uniqueMatchableToken alpha rules"}',
      status: "complete",
      ts: 1,
      lastEventSeq: 1,
    });
    insertBlock({
      blockId: "blk-match-2",
      turnId: "turn-1",
      agentName: "beta",
      sessionId: "sess-1",
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      contentJson: '{"text":"unrelated"}',
      status: "complete",
      ts: 2,
      lastEventSeq: 2,
    });
    const r = fetchBlocksByAgent({
      agentName: "alpha",
      match: "uniqueMatchableToken",
      limit: 10,
    });
    expect(r.blocks.map((b) => b.blockId)).toEqual(["blk-match-1"]);
    expect(r.lastEventSeq).toBe(1);
  });

  it("fetchBlocksByAgent returns lastEventSeq=0 on empty result", async () => {
    const { fetchBlocksByAgent } = await import("./blocks.js");
    const r = fetchBlocksByAgent({ agentName: "empty-agent" });
    expect(r.blocks).toEqual([]);
    expect(r.lastEventSeq).toBe(0);
  });

  it("matchBlocks performs FTS lookup scoped by agent", async () => {
    const { insertBlock, matchBlocks } = await import("./blocks.js");
    insertBlock({
      blockId: "blk-fts-1",
      turnId: "turn-1",
      agentName: "alpha",
      sessionId: "sess-1",
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      contentJson: '{"text":"the quick uniqueFtsToken jumps"}',
      status: "complete",
      ts: 1,
      lastEventSeq: 1,
    });
    insertBlock({
      blockId: "blk-fts-2",
      turnId: "turn-1",
      agentName: "beta",
      sessionId: "sess-1",
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      contentJson: '{"text":"unrelated"}',
      status: "complete",
      ts: 1,
      lastEventSeq: 1,
    });

    const all = matchBlocks({ match: "uniqueFtsToken" });
    expect(all.length).toBe(1);
    expect(all[0].blockId).toBe("blk-fts-1");

    const alphaOnly = matchBlocks({ agentName: "alpha", match: "uniqueFtsToken" });
    expect(alphaOnly.length).toBe(1);

    const betaOnly = matchBlocks({ agentName: "beta", match: "uniqueFtsToken" });
    expect(betaOnly.length).toBe(0);
  });

  it("getToolResultByToolUseId finds a tool_result row by tool_use_id even when message_id is null", async () => {
    // The case this lookup exists for: jsonl-recovery's reconcile path
    // for user-role tool_result entries that the SDK writes with null
    // message_id. The (sessionId, messageId, blockIndex) natural key
    // can't match (NULL != NULL in SQL); tool_use_id is the stable key.
    const { insertBlock, getToolResultByToolUseId } = await import(
      "./blocks.js"
    );
    insertBlock({
      blockId: "blk-tr-1",
      turnId: "recover_sess-tr",
      agentName: "alpha",
      sessionId: "sess-tr",
      messageId: null,
      blockIndex: 0,
      role: "assistant",
      kind: "tool_result",
      source: null,
      contentJson: JSON.stringify({
        tool_use_id: "toolu_ABC123",
        text: "ok",
        is_error: false,
      }),
      status: "complete",
      ts: 100,
      lastEventSeq: 1,
    });

    const hit = getToolResultByToolUseId("sess-tr", "toolu_ABC123");
    expect(hit?.blockId).toBe("blk-tr-1");
    expect(hit?.kind).toBe("tool_result");

    // Negative: a different session id with the same tool_use_id is a miss.
    expect(getToolResultByToolUseId("sess-other", "toolu_ABC123")).toBeNull();
    // Negative: same session, wrong tool_use_id is a miss.
    expect(getToolResultByToolUseId("sess-tr", "toolu_OTHER")).toBeNull();
  });

  it("getToolResultByToolUseId only matches kind='tool_result' rows", async () => {
    // Belt-and-suspenders: even if some other kind happened to embed the
    // same `tool_use_id` in content_json (tool_use blocks DO carry it),
    // the lookup must not return them. Otherwise tool_use blocks would
    // dedup-block tool_result inserts, breaking recovery.
    const { insertBlock, getToolResultByToolUseId } = await import(
      "./blocks.js"
    );
    insertBlock({
      blockId: "blk-tu",
      turnId: "t",
      agentName: "alpha",
      sessionId: "sess-tr2",
      messageId: "msg-1",
      blockIndex: 0,
      role: "assistant",
      kind: "tool_use",
      contentJson: JSON.stringify({
        tool_use_id: "toolu_X",
        name: "Bash",
        input: {},
      }),
      status: "complete",
      ts: 1,
      lastEventSeq: 1,
    });
    expect(getToolResultByToolUseId("sess-tr2", "toolu_X")).toBeNull();
  });
});
