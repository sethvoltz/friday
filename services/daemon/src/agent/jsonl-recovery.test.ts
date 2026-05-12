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
});
