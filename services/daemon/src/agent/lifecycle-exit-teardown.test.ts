import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// F4-A regression: when the worker process exits without going through
// `runQuery`'s try/catch (SIGTERM from the stall watchdog, SIGKILL, OOM,
// crash), no `block-stop` IPC ever fires for the in-flight blocks. Before
// this fix the rows stayed at `status='streaming'` and the dashboard
// rendered tool/thinking bubbles as `running` forever. The exit handler
// now finalizes them via `finalizeStreamingBlocks`.

const dataDir = mkdtempSync(join(tmpdir(), "friday-lifecycle-exit-"));
process.env.FRIDAY_DATA_DIR = dataDir;

beforeAll(async () => {
  const { runMigrations } = await import("@friday/shared");
  runMigrations();
});

afterAll(async () => {
  const { closeDb } = await import("@friday/shared");
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getRawDb } = await import("@friday/shared");
  getRawDb().prepare("DELETE FROM blocks").run();
  const liveTurns = await import("./live-turns.js");
  liveTurns.__resetForTest();
});

function makeFakeWorker(): unknown {
  return {
    child: { send: () => {} },
    pgid: 0,
    agentName: "exit-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-exit-1",
    sessionId: "sess-exit-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now(),
    spawnedAt: Date.now(),
    lastBlockStop: Date.now(),
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
  };
}

describe("finalizeStreamingBlocks (F4-A)", () => {
  it("flips streaming thinking + tool_use rows to error on worker exit", async () => {
    const { finalizeStreamingBlocks } = await import("./lifecycle.js");
    const { insertBlock, getBlockById } = await import("@friday/shared/services");
    const liveTurns = await import("./live-turns.js");

    // Mirror what handleBlockStart would have done: insert a streaming
    // DB row AND register the block with liveTurns so the exit handler
    // has the live state to finalize from.
    insertBlock({
      blockId: "th-blk",
      turnId: "turn-exit-1",
      agentName: "exit-agent",
      sessionId: "sess-exit-1",
      messageId: "msg-1",
      blockIndex: 0,
      role: "assistant",
      kind: "thinking",
      contentJson: "",
      status: "streaming",
      ts: 1,
      lastEventSeq: 1,
    });
    liveTurns.startBlock({
      turnId: "turn-exit-1",
      agentName: "exit-agent",
      sessionId: "sess-exit-1",
      clientBlockId: "c-th",
      blockId: "th-blk",
      messageId: "msg-1",
      blockIndex: 0,
      role: "assistant",
      kind: "thinking",
      source: null,
      ts: 1,
      seq: 1,
    });
    liveTurns.appendDelta("turn-exit-1", "c-th", { text: "partial thought" }, 2);

    insertBlock({
      blockId: "tu-blk",
      turnId: "turn-exit-1",
      agentName: "exit-agent",
      sessionId: "sess-exit-1",
      messageId: "msg-1",
      blockIndex: 1,
      role: "assistant",
      kind: "tool_use",
      contentJson: "",
      status: "streaming",
      ts: 1,
      lastEventSeq: 1,
    });
    liveTurns.startBlock({
      turnId: "turn-exit-1",
      agentName: "exit-agent",
      sessionId: "sess-exit-1",
      clientBlockId: "c-tu",
      blockId: "tu-blk",
      messageId: "msg-1",
      blockIndex: 1,
      role: "assistant",
      kind: "tool_use",
      source: null,
      tool: { id: "toolu_FOO", name: "Bash" },
      ts: 1,
      seq: 1,
    });
    liveTurns.appendDelta(
      "turn-exit-1",
      "c-tu",
      { partial_json: '{"command":"echo' },
      3,
    );

    finalizeStreamingBlocks(makeFakeWorker() as never, "error");

    const thinking = getBlockById("th-blk");
    expect(thinking?.status).toBe("error");
    // Accumulated delta carries through so the finalized bubble shows
    // whatever made it onto the wire instead of an empty placeholder.
    expect(thinking?.contentJson).toBe(
      JSON.stringify({ text: "partial thought" }),
    );

    const tu = getBlockById("tu-blk");
    expect(tu?.status).toBe("error");
    // Malformed partial_json falls back to `_raw` so the bubble still
    // renders something diagnostic.
    expect(tu?.contentJson).toBe(
      JSON.stringify({
        tool_use_id: "toolu_FOO",
        name: "Bash",
        input: { _raw: '{"command":"echo' },
      }),
    );
  });

  it("is a no-op when the worker exited cleanly (no live turn)", async () => {
    const { finalizeStreamingBlocks } = await import("./lifecycle.js");
    // No liveTurns entry for `turn-exit-1`. Must not throw, must not
    // touch the DB.
    expect(() => {
      finalizeStreamingBlocks(makeFakeWorker() as never, "error");
    }).not.toThrow();
  });

  it("FRI-4 #2 (Layer B): marks orphan blocks 'aborted' on turn-rotation", async () => {
    // Reproduces the production scenario: the SDK abandoned a thinking
    // content block mid-stream (no content_block_stop ever fired). The
    // worker's pre-break flush is the primary defense; this test pins
    // the daemon-side belt-and-braces — even if the worker missed it,
    // the turn-complete handler must transition the DB row off
    // `streaming` before `dropTurn` wipes the liveTurns entry.
    const { finalizeStreamingBlocks } = await import("./lifecycle.js");
    const { insertBlock, getBlockById } = await import(
      "@friday/shared/services"
    );
    const liveTurns = await import("./live-turns.js");

    insertBlock({
      blockId: "th-orphan",
      turnId: "turn-exit-1",
      agentName: "exit-agent",
      sessionId: "sess-exit-1",
      messageId: "msg-orphan",
      blockIndex: 0,
      role: "assistant",
      kind: "thinking",
      contentJson: "",
      status: "streaming",
      ts: 1,
      lastEventSeq: 1,
    });
    liveTurns.startBlock({
      turnId: "turn-exit-1",
      agentName: "exit-agent",
      sessionId: "sess-exit-1",
      clientBlockId: "c-th-orphan",
      blockId: "th-orphan",
      messageId: "msg-orphan",
      blockIndex: 0,
      role: "assistant",
      kind: "thinking",
      source: null,
      ts: 1,
      seq: 1,
    });

    finalizeStreamingBlocks(makeFakeWorker() as never, "aborted");

    const row = getBlockById("th-orphan");
    expect(row?.status).toBe("aborted");
  });
});
