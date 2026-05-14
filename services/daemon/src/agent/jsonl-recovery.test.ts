import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// DATA_DIR is frozen at @friday/shared module-load time. Set it before any
// import, then reuse the same DB across tests and clear rows in between.

const dataDir = mkdtempSync(join(tmpdir(), "friday-data-"));
process.env.FRIDAY_DATA_DIR = dataDir;

let projectsRoot: string;

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
  projectsRoot = mkdtempSync(join(tmpdir(), "friday-home-"));
  process.env.HOME = projectsRoot;
  const { getRawDb } = await import("@friday/shared");
  getRawDb().prepare("DELETE FROM blocks").run();
});

afterEach(() => {
  rmSync(projectsRoot, { recursive: true, force: true });
});

function writeSessionJsonl(
  cwd: string,
  sessionId: string,
  lines: object[],
): void {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const sdkDir = join(projectsRoot, ".claude", "projects", encoded);
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(
    join(sdkDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

async function rawBlocks(): Promise<
  Array<{
    message_id: string | null;
    block_index: number;
    kind: string;
    role: string;
    content_json: string;
    status: string;
  }>
> {
  const { getRawDb } = await import("@friday/shared");
  return getRawDb()
    .prepare(
      "SELECT message_id, block_index, kind, role, content_json, status FROM blocks ORDER BY message_id, block_index",
    )
    .all() as Array<{
      message_id: string | null;
      block_index: number;
      kind: string;
      role: string;
      content_json: string;
      status: string;
    }>;
}

describe("jsonl-recovery (FIX_FORWARD 1.3)", () => {
  it("inserts assistant text/thinking/tool_use + user tool_result blocks", async () => {
    const cwd = "/tmp/agent-cwd-recover-1";
    const sessionId = "sess-recover-1";
    writeSessionJsonl(cwd, sessionId, [
      {
        type: "assistant",
        timestamp: "2026-05-12T10:00:00.000Z",
        message: {
          id: "msg-A",
          content: [
            { type: "text", text: "hello recovered world" },
            { type: "thinking", thinking: "internal reasoning" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-05-12T10:00:01.000Z",
        message: {
          id: "msg-B",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "file1\nfile2",
              is_error: false,
            },
          ],
        },
      },
    ]);

    const { recoverFromJsonl } = await import("./jsonl-recovery.js");
    const { eventBus } = await import("../events/bus.js");

    const captured: Array<{ type?: string; inserted?: number; block_ids?: string[] }> = [];
    const unsub = eventBus.subscribe((e) =>
      captured.push(e as { type?: string; inserted?: number; block_ids?: string[] }),
    );

    const stats = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    unsub();

    expect(stats.sessionsScanned).toBe(1);
    expect(stats.inserted).toBe(4);
    expect(stats.updated).toBe(0);

    const rows = await rawBlocks();
    expect(rows.map((r) => ({ mid: r.message_id, idx: r.block_index, kind: r.kind }))).toEqual([
      { mid: "msg-A", idx: 0, kind: "text" },
      { mid: "msg-A", idx: 1, kind: "thinking" },
      { mid: "msg-A", idx: 2, kind: "tool_use" },
      { mid: "msg-B", idx: 0, kind: "tool_result" },
    ]);

    const reload = captured.find((e) => e.type === "block_reload");
    expect(reload).toBeDefined();
    expect(reload!.inserted).toBe(4);
    expect((reload!.block_ids ?? []).length).toBe(4);
  });

  it("is idempotent: re-running inserts nothing and emits no reload event", async () => {
    const cwd = "/tmp/agent-cwd-recover-2";
    const sessionId = "sess-recover-2";
    writeSessionJsonl(cwd, sessionId, [
      {
        type: "assistant",
        timestamp: "2026-05-12T10:00:00.000Z",
        message: {
          id: "msg-X",
          content: [{ type: "text", text: "idempotent check" }],
        },
      },
    ]);

    const { recoverFromJsonl } = await import("./jsonl-recovery.js");
    const first = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    expect(first.inserted).toBe(1);

    const { eventBus } = await import("../events/bus.js");
    const captured: Array<{ type?: string }> = [];
    const unsub = eventBus.subscribe((e) =>
      captured.push(e as { type?: string }),
    );
    const second = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    unsub();
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(captured.find((e) => e.type === "block_reload")).toBeUndefined();
  });

  it("skips user-text entries to avoid duplicating recordUserBlock writes", async () => {
    const cwd = "/tmp/agent-cwd-recover-3";
    const sessionId = "sess-recover-3";
    writeSessionJsonl(cwd, sessionId, [
      {
        type: "user",
        timestamp: "2026-05-12T10:00:00.000Z",
        message: {
          id: "msg-user-1",
          content: [{ type: "text", text: "user prompt — recorded by chat/turn" }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-05-12T10:00:01.000Z",
        message: {
          id: "msg-asst-1",
          content: [{ type: "text", text: "assistant reply" }],
        },
      },
    ]);

    const { recoverFromJsonl } = await import("./jsonl-recovery.js");
    const stats = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    expect(stats.inserted).toBe(1);

    const rows = await rawBlocks();
    expect(rows.length).toBe(1);
    expect(rows[0].message_id).toBe("msg-asst-1");
  });

  it("skips sidechain entries (Task sub-agent traffic)", async () => {
    const cwd = "/tmp/agent-cwd-recover-4";
    const sessionId = "sess-recover-4";
    writeSessionJsonl(cwd, sessionId, [
      {
        type: "assistant",
        isSidechain: true,
        timestamp: "2026-05-12T10:00:00.000Z",
        message: {
          id: "msg-sub",
          content: [{ type: "text", text: "subagent content" }],
        },
      },
    ]);

    const { recoverFromJsonl } = await import("./jsonl-recovery.js");
    const stats = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    expect(stats.inserted).toBe(0);
  });

  it("UPDATEs a row when content_json differs from the JSONL", async () => {
    const cwd = "/tmp/agent-cwd-recover-5";
    const sessionId = "sess-recover-5";

    // Pre-write a streaming row that never completed (status='streaming',
    // partial content) for the natural key (sess, msg-Z, 0). Recovery
    // should bring it to status='complete' with the JSONL's full content.
    const { insertBlock } = await import("@friday/shared/services");
    insertBlock({
      blockId: "preexisting-block",
      turnId: "turn-old",
      agentName: "alpha",
      sessionId,
      messageId: "msg-Z",
      blockIndex: 0,
      role: "assistant",
      kind: "text",
      source: null,
      contentJson: JSON.stringify({ text: "partial only" }),
      status: "streaming",
      ts: 1,
      lastEventSeq: 1,
    });

    writeSessionJsonl(cwd, sessionId, [
      {
        type: "assistant",
        timestamp: "2026-05-12T10:00:00.000Z",
        message: {
          id: "msg-Z",
          content: [{ type: "text", text: "complete content from JSONL" }],
        },
      },
    ]);

    const { recoverFromJsonl } = await import("./jsonl-recovery.js");
    const stats = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    expect(stats.updated).toBe(1);
    expect(stats.inserted).toBe(0);

    const rows = await rawBlocks();
    expect(rows.length).toBe(1);
    expect(rows[0].content_json).toBe(
      JSON.stringify({ text: "complete content from JSONL" }),
    );
    expect(rows[0].status).toBe("complete");
  });

  it("reconciles tool_result entries with null message.id (the JSONL norm)", async () => {
    // The Claude SDK writes tool_result user entries without a message.id
    // — the SDK flushes user-role messages before the API assigns ids. The
    // pre-fix recovery code skipped these entirely (messageId required at
    // the natural-key dedup), orphaning every tool_result in DB. Recovery
    // now uses (session_id, tool_use_id) as the dedup key for this kind,
    // so null message_id is fine.
    const cwd = "/tmp/some/cwd";
    const sessionId = "sess-nullmsgid";
    writeSessionJsonl(cwd, sessionId, [
      {
        type: "assistant",
        timestamp: "2026-05-12T10:00:00.000Z",
        message: {
          id: "msg-assistant-1",
          content: [
            {
              type: "tool_use",
              id: "toolu_NULL_MSG_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        // Note: no message.id field at all (or id: null).
        type: "user",
        timestamp: "2026-05-12T10:00:01.000Z",
        message: {
          // id intentionally omitted — this is the actual SDK JSONL shape
          // for tool_result-bearing user messages.
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_NULL_MSG_1",
              content: "ok\n",
              is_error: false,
            },
          ],
        },
      },
    ]);

    const { recoverFromJsonl } = await import("./jsonl-recovery.js");
    const stats = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    expect(stats.inserted).toBe(2); // tool_use + tool_result
    expect(stats.skipped).toBe(0);

    const rows = await rawBlocks();
    expect(rows.length).toBe(2);
    const tr = rows.find((r) => r.kind === "tool_result");
    expect(tr).toBeDefined();
    expect(tr?.message_id).toBeNull();
    const tu = rows.find((r) => r.kind === "tool_use");
    expect(tu?.message_id).toBe("msg-assistant-1");
  });

  it("preserves all three content kinds when the SDK splits one message across per-block JSONL entries", async () => {
    // Regression for the data-corruption bug surfaced in the orchestrator's
    // session: the Claude SDK writes a single assistant message to JSONL
    // as multiple entries (one per content block), each entry's `content`
    // array starting fresh at index 0. Pre-fix recovery used
    // (session_id, message_id, block_index) as the dedup key, so the
    // thinking-chunk and text-chunk and tool_use-chunk all collided at
    // (msg-X, 0). updateBlock can't change `kind`, so the row's
    // content_json got overwritten while its kind stayed "thinking",
    // and the tool_use row was never persisted — leaving the matching
    // tool_result orphaned and rendering as "(unknown)" in the dashboard.
    //
    // Post-fix: text/thinking dedup by (session, message, kind, idx),
    // tool_use dedups by (session, tool_use_id). All three chunks land
    // in DB as their correct kind with their correct content.
    const cwd = "/tmp/agent-cwd-streaming-chunks";
    const sessionId = "sess-streaming-chunks";
    writeSessionJsonl(cwd, sessionId, [
      {
        type: "assistant",
        timestamp: "2026-05-12T10:00:00.000Z",
        message: {
          id: "msg-Multi",
          content: [{ type: "thinking", thinking: "internal reasoning" }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-05-12T10:00:00.500Z",
        message: {
          id: "msg-Multi",
          content: [{ type: "text", text: "user-visible reply" }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-05-12T10:00:01.000Z",
        message: {
          id: "msg-Multi",
          content: [
            {
              type: "tool_use",
              id: "toolu_MultiX",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-05-12T10:00:01.500Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_MultiX",
              content: "file1\nfile2",
              is_error: false,
            },
          ],
        },
      },
    ]);

    const { recoverFromJsonl } = await import("./jsonl-recovery.js");
    const stats = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    expect(stats.inserted).toBe(4); // thinking + text + tool_use + tool_result

    const rows = await rawBlocks();
    const byKind: Record<string, { content_json: string; message_id: string | null }> = {};
    for (const r of rows) byKind[r.kind] = r;

    // Each chunk landed as its own kind with the correct content.
    expect(byKind.thinking).toBeDefined();
    expect(JSON.parse(byKind.thinking.content_json)).toEqual({
      text: "internal reasoning",
    });
    expect(byKind.text).toBeDefined();
    expect(JSON.parse(byKind.text.content_json)).toEqual({
      text: "user-visible reply",
    });
    expect(byKind.tool_use).toBeDefined();
    expect(JSON.parse(byKind.tool_use.content_json)).toEqual({
      tool_use_id: "toolu_MultiX",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(byKind.tool_result).toBeDefined();
    // The tool_result is no longer orphaned — its tool_use is in DB.
    expect(JSON.parse(byKind.tool_result.content_json).tool_use_id).toBe(
      "toolu_MultiX",
    );
  });

  it("tool_use dedup uses tool_use_id (live IPC wrote at a different block_index)", async () => {
    // The live IPC path stores tool_use at the SDK stream's `e.index`,
    // which is global within the message (e.g., 1 if thinking is at 0).
    // The JSONL splits the same message into per-block entries, each at
    // content index 0. Dedup by (message_id, block_index) would miss
    // the live row and double-insert. Dedup by tool_use_id matches.
    const cwd = "/tmp/agent-cwd-tu-dedup";
    const sessionId = "sess-tu-dedup";
    const { insertBlock } = await import("@friday/shared/services");

    // Pre-write the row the live IPC would have produced: tool_use at
    // block_index=1 (after a hypothetical thinking block at 0).
    insertBlock({
      blockId: "live-tu",
      turnId: "t-live",
      agentName: "alpha",
      sessionId,
      messageId: "msg-T",
      blockIndex: 1,
      role: "assistant",
      kind: "tool_use",
      contentJson: JSON.stringify({
        tool_use_id: "toolu_LiveFirst",
        name: "Bash",
        input: { command: "pwd" },
      }),
      status: "complete",
      ts: 50,
      lastEventSeq: 1,
    });

    // JSONL has the tool_use as a standalone entry at content index 0.
    writeSessionJsonl(cwd, sessionId, [
      {
        type: "assistant",
        timestamp: "2026-05-12T10:00:00.000Z",
        message: {
          id: "msg-T",
          content: [
            {
              type: "tool_use",
              id: "toolu_LiveFirst",
              name: "Bash",
              input: { command: "pwd" },
            },
          ],
        },
      },
    ]);

    const { recoverFromJsonl } = await import("./jsonl-recovery.js");
    const stats = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    // Content matches → skipped, no duplicate inserted.
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);

    const rows = await rawBlocks();
    expect(rows.length).toBe(1);
    expect(rows[0].block_index).toBe(1); // live row preserved at its idx
  });

  it("text dedup ignores block_index (live IPC at idx=1, JSONL at idx=0) — FRI-4", async () => {
    // Regression: live worker stamps the SDK stream's e.index (1 here,
    // because a thinking block precedes the text in the assembled
    // message). The SDK persists the same message as per-block JSONL
    // entries — the text entry's content array is just `[text]` at idx
    // 0. With block_index in the dedup natural key, recovery's idx=0
    // lookup missed the live row at idx=1 and inserted a parallel row
    // with a fresh blockId, surfacing as a duplicate text bubble in
    // chat. Dropping block_index from the key fixes it.
    const cwd = "/tmp/agent-cwd-text-dedup";
    const sessionId = "sess-text-dedup";
    const { insertBlock } = await import("@friday/shared/services");

    // Pre-write the live IPC row: text at block_index=1.
    insertBlock({
      blockId: "live-text",
      turnId: "t-live-text",
      agentName: "alpha",
      sessionId,
      messageId: "msg-textdup",
      blockIndex: 1,
      role: "assistant",
      kind: "text",
      contentJson: JSON.stringify({ text: "hello world" }),
      status: "complete",
      ts: 50,
      lastEventSeq: 1,
    });

    // JSONL has the text as its own assistant entry, content[0] = text.
    writeSessionJsonl(cwd, sessionId, [
      {
        type: "assistant",
        timestamp: "2026-05-12T10:00:00.000Z",
        message: {
          id: "msg-textdup",
          content: [{ type: "text", text: "hello world" }],
        },
      },
    ]);

    const { recoverFromJsonl } = await import("./jsonl-recovery.js");
    const stats = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    // Live row matches by (session, message_id, kind) regardless of
    // index; content matches → skipped, no duplicate inserted.
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(1);

    const rows = await rawBlocks();
    expect(rows.length).toBe(1);
    expect(rows[0].block_index).toBe(1); // live row preserved
    expect(rows[0].kind).toBe("text");
  });

  it("is idempotent for tool_result rows (re-running recovery doesn't duplicate)", async () => {
    const cwd = "/tmp/some/cwd";
    const sessionId = "sess-idempot-tr";
    writeSessionJsonl(cwd, sessionId, [
      {
        type: "user",
        timestamp: "2026-05-12T10:00:01.000Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_IDEMPOT_1",
              content: "result text",
              is_error: false,
            },
          ],
        },
      },
    ]);

    const { recoverFromJsonl } = await import("./jsonl-recovery.js");
    const first = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    expect(first.inserted).toBe(1);

    const second = recoverFromJsonl([
      { agentName: "alpha", sessionId, workingDirectory: cwd },
    ]);
    // Same content → skipped, not duplicated.
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(1);

    const rows = await rawBlocks();
    expect(rows.length).toBe(1);
  });
});
