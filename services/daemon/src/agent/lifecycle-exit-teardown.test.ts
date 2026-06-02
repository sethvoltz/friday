import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

// F4-A regression: when the worker process exits without going through
// `runQuery`'s try/catch (SIGTERM from the stall watchdog, SIGKILL, OOM,
// crash), no `block-stop` IPC ever fires for the in-flight blocks. Before
// the original fix the rows stayed at `status='streaming'` and the
// dashboard rendered tool/thinking bubbles as `running` forever. The
// exit handler now finalizes them via `blockStream.tearDownTurn` (FRI-148 A
// fused the prior finalize + endTurn pair; FRI-125 migrated this path from
// `finalizeStreamingBlocks`).

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_exit" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  const { __resetForTest } = await import("./block-stream.js");
  __resetForTest();
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
    blocksThisTurn: 0,
  };
}

describe("blockStream.tearDownTurn (F4-A; FRI-125 migration; FRI-148 A fuse)", () => {
  it("flips streaming thinking + tool_use rows to error on worker exit", async () => {
    const { tearDownTurn, __seedForTest } = await import("./block-stream.js");
    const { insertBlock, getBlockById } = await import("@friday/shared/services");

    // Seed the streaming DB rows the way the legacy "INSERT at
    // block_start" path used to leave them. Post-ADR-024 the daemon
    // doesn't INSERT until block_complete, so in production these rows
    // only exist via error-block insertion or migration artefacts —
    // but `tearDownTurn` still has to flip them off `streaming` correctly,
    // which is exactly what this test pins.
    await insertBlock({
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
    });
    await insertBlock({
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
    });

    __seedForTest({
      turnId: "turn-exit-1",
      agent: "exit-agent",
      sessionId: "sess-exit-1",
      blocks: [
        {
          blockId: "th-blk",
          clientBlockId: "c-th",
          turnId: "turn-exit-1",
          agentName: "exit-agent",
          sessionId: "sess-exit-1",
          messageId: "msg-1",
          blockIndex: 0,
          role: "assistant",
          kind: "thinking",
          source: null,
          text: "partial thought",
          partialJson: "",
          startedAt: 1,
        },
        {
          blockId: "tu-blk",
          clientBlockId: "c-tu",
          turnId: "turn-exit-1",
          agentName: "exit-agent",
          sessionId: "sess-exit-1",
          messageId: "msg-1",
          blockIndex: 1,
          role: "assistant",
          kind: "tool_use",
          source: null,
          tool: { id: "toolu_FOO", name: "Bash" },
          text: "",
          partialJson: '{"command":"echo',
          startedAt: 1,
        },
      ],
      startedAt: 1,
    });

    await tearDownTurn(makeFakeWorker() as never, "error");

    const thinking = await getBlockById("th-blk");
    expect(thinking?.status).toBe("error");
    // Accumulated delta carries through so the finalized bubble shows
    // whatever made it onto the wire instead of an empty placeholder.
    // contentJson is normalized to a JSON string by getBlockById, but jsonb
    // storage doesn't preserve key order — parse before structural compare.
    expect(JSON.parse(thinking!.contentJson)).toEqual({
      text: "partial thought",
    });

    const tu = await getBlockById("tu-blk");
    expect(tu?.status).toBe("error");
    // Malformed partial_json falls back to `_raw` so the bubble still
    // renders something diagnostic.
    expect(JSON.parse(tu!.contentJson)).toEqual({
      tool_use_id: "toolu_FOO",
      name: "Bash",
      input: { _raw: '{"command":"echo' },
    });
  });

  it("is a no-op when the worker exited cleanly (no live turn)", async () => {
    const { tearDownTurn } = await import("./block-stream.js");
    // No in-flight entry for `turn-exit-1`. Must not throw, must not
    // touch the DB. FRI-148 A: tearDownTurn also drops the turn entry
    // — idempotent on a missing entry.
    await expect(tearDownTurn(makeFakeWorker() as never, "error")).resolves.toBeUndefined();
  });

  it("FRI-4 #2 (Layer B): marks orphan blocks 'aborted' on turn-rotation", async () => {
    // Reproduces the production scenario: the SDK abandoned a thinking
    // content block mid-stream (no content_block_stop ever fired). The
    // worker's pre-break flush is the primary defense; this test pins
    // the daemon-side belt-and-braces — even if the worker missed it,
    // the turn-complete handler must transition the DB row off
    // `streaming` before `endTurn` wipes the live entry.
    const { tearDownTurn, __seedForTest } = await import("./block-stream.js");
    const { insertBlock, getBlockById } = await import("@friday/shared/services");

    await insertBlock({
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
    });
    __seedForTest({
      turnId: "turn-exit-1",
      agent: "exit-agent",
      sessionId: "sess-exit-1",
      blocks: [
        {
          blockId: "th-orphan",
          clientBlockId: "c-th-orphan",
          turnId: "turn-exit-1",
          agentName: "exit-agent",
          sessionId: "sess-exit-1",
          messageId: "msg-orphan",
          blockIndex: 0,
          role: "assistant",
          kind: "thinking",
          source: null,
          text: "",
          partialJson: "",
          startedAt: 1,
        },
      ],
      startedAt: 1,
    });

    await tearDownTurn(makeFakeWorker() as never, "aborted");

    const row = await getBlockById("th-orphan");
    expect(row?.status).toBe("aborted");
  });
});
