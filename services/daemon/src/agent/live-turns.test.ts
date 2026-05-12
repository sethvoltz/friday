import { beforeEach, describe, expect, it } from "vitest";
import * as liveTurns from "./live-turns.js";

beforeEach(() => {
  liveTurns.__resetForTest();
});

const baseStart: liveTurns.StartBlockInput = {
  turnId: "turn-1",
  agentName: "alpha",
  sessionId: "sess-1",
  clientBlockId: "client-1",
  blockId: "uuid-1",
  messageId: "msg-1",
  blockIndex: 0,
  role: "assistant",
  kind: "text",
  source: null,
  ts: 1000,
  seq: 5,
};

describe("liveTurns registry (FIX_FORWARD 1.4)", () => {
  it("startBlock creates a turn entry on first block and adds the block", () => {
    expect(liveTurns.size()).toBe(0);
    liveTurns.startBlock(baseStart);
    expect(liveTurns.size()).toBe(1);

    const lt = liveTurns.getLiveTurn("turn-1");
    expect(lt).not.toBeNull();
    expect(lt!.agent).toBe("alpha");
    expect(lt!.sessionId).toBe("sess-1");
    expect(lt!.lastEventSeq).toBe(5);
    expect(lt!.blocks.size).toBe(1);
    const b = lt!.blocks.get("client-1");
    expect(b).toBeDefined();
    expect(b!.blockId).toBe("uuid-1");
  });

  it("startBlock reuses the existing turn entry for subsequent blocks", () => {
    liveTurns.startBlock(baseStart);
    liveTurns.startBlock({
      ...baseStart,
      clientBlockId: "client-2",
      blockId: "uuid-2",
      blockIndex: 1,
      seq: 8,
    });
    expect(liveTurns.size()).toBe(1);
    const lt = liveTurns.getLiveTurn("turn-1");
    expect(lt!.blocks.size).toBe(2);
    expect(lt!.lastEventSeq).toBe(8);
  });

  it("appendDelta accumulates text and bumps lastEventSeq", () => {
    liveTurns.startBlock(baseStart);
    const after = liveTurns.appendDelta(
      "turn-1",
      "client-1",
      { text: "hello " },
      6,
    );
    expect(after).not.toBeNull();
    expect(after!.text).toBe("hello ");

    const after2 = liveTurns.appendDelta(
      "turn-1",
      "client-1",
      { text: "world" },
      7,
    );
    expect(after2!.text).toBe("hello world");

    const lt = liveTurns.getLiveTurn("turn-1");
    expect(lt!.lastEventSeq).toBe(7);
  });

  it("appendDelta accumulates partial_json separately from text", () => {
    liveTurns.startBlock({ ...baseStart, kind: "tool_use" });
    const a = liveTurns.appendDelta(
      "turn-1",
      "client-1",
      { partial_json: '{"cmd":' },
      6,
    );
    expect(a!.partialJson).toBe('{"cmd":');
    const b = liveTurns.appendDelta(
      "turn-1",
      "client-1",
      { partial_json: '"ls"}' },
      7,
    );
    expect(b!.partialJson).toBe('{"cmd":"ls"}');
    expect(b!.text).toBe("");
  });

  it("appendDelta returns null for unknown turn or block (stale event)", () => {
    expect(
      liveTurns.appendDelta("missing-turn", "client-1", { text: "x" }, 1),
    ).toBeNull();
    liveTurns.startBlock(baseStart);
    expect(
      liveTurns.appendDelta("turn-1", "missing-client", { text: "x" }, 1),
    ).toBeNull();
  });

  it("finishBlock removes the block but keeps the turn entry", () => {
    liveTurns.startBlock(baseStart);
    liveTurns.startBlock({
      ...baseStart,
      clientBlockId: "client-2",
      blockId: "uuid-2",
      blockIndex: 1,
      seq: 6,
    });
    expect(liveTurns.getLiveTurn("turn-1")!.blocks.size).toBe(2);

    const finished = liveTurns.finishBlock("turn-1", "client-1", 10);
    expect(finished).not.toBeNull();
    expect(finished!.blockId).toBe("uuid-1");

    const lt = liveTurns.getLiveTurn("turn-1");
    expect(lt!.blocks.size).toBe(1);
    expect(lt!.blocks.get("client-1")).toBeUndefined();
    expect(lt!.lastEventSeq).toBe(10);
  });

  it("finishBlock returns null when the block isn't live (stale stop)", () => {
    liveTurns.startBlock(baseStart);
    liveTurns.finishBlock("turn-1", "client-1", 6);
    expect(liveTurns.finishBlock("turn-1", "client-1", 7)).toBeNull();
  });

  it("dropTurn removes the entire turn entry", () => {
    liveTurns.startBlock(baseStart);
    expect(liveTurns.size()).toBe(1);
    liveTurns.dropTurn("turn-1");
    expect(liveTurns.size()).toBe(0);
    expect(liveTurns.getLiveTurn("turn-1")).toBeNull();
  });

  it("dropTurn is a no-op for unknown turn ids", () => {
    expect(() => liveTurns.dropTurn("never-existed")).not.toThrow();
  });

  it("snapshot returns one entry per live turn", () => {
    liveTurns.startBlock(baseStart);
    liveTurns.startBlock({ ...baseStart, turnId: "turn-2", clientBlockId: "c-x" });
    const snap = liveTurns.snapshot();
    expect(snap.map((t) => t.turnId).sort()).toEqual(["turn-1", "turn-2"]);
  });
});
