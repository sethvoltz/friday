/**
 * FRI-78 break-timing helper.
 *
 * When the worker's `pendingCriticalMail` / `promptsPending` flag is set, the
 * for-await loop must decide whether to break the SDK iterator immediately at
 * the assistant-message boundary or defer to the next `user` (tool_results)
 * message. The pivot is whether the just-yielded assistant message carries
 * tool_use blocks: if it does, breaking now leaves the SDK session JSONL with
 * a dangling `assistant→tool_use` and the next `runQuery`'s resume returns
 * "Stream closed" on the model's first tool dispatch (Seth's dashboard
 * reproduction with `fri-75-design-review → friday` mail id 87). Deferring
 * until the SDK has delivered the matching `user→tool_result` keeps the
 * transcript consistent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEntries } from "@friday/shared";
import { assistantMessageHasToolUses } from "./worker.js";
import { healDanglingToolUseInJsonl } from "./sdk-jsonl-heal.js";
import { sessionFilePath } from "./jsonl-paths.js";

describe("assistantMessageHasToolUses", () => {
  it("returns true when content includes a tool_use block (defer break)", () => {
    const msg = {
      content: [
        { type: "text", text: "Let me check the inbox." },
        { type: "tool_use", id: "tu_1", name: "mcp__friday-mail__mail_read", input: { id: 87 } },
      ],
    };
    expect(assistantMessageHasToolUses(msg)).toBe(true);
  });

  it("returns true when content is tool_use only", () => {
    const msg = {
      content: [
        { type: "tool_use", id: "tu_1", name: "mcp__friday-mail__mail_read", input: { id: 87 } },
      ],
    };
    expect(assistantMessageHasToolUses(msg)).toBe(true);
  });

  it("returns false on a pure-text assistant message (break immediately)", () => {
    const msg = {
      content: [{ type: "text", text: "Got it, will do." }],
    };
    expect(assistantMessageHasToolUses(msg)).toBe(false);
  });

  it("returns false when thinking + text but no tool_use", () => {
    const msg = {
      content: [
        { type: "thinking", text: "Considering options…" },
        { type: "text", text: "Done." },
      ],
    };
    expect(assistantMessageHasToolUses(msg)).toBe(false);
  });

  it("returns false on empty content array", () => {
    expect(assistantMessageHasToolUses({ content: [] })).toBe(false);
  });

  it("returns false when content is missing", () => {
    expect(assistantMessageHasToolUses({})).toBe(false);
  });

  it("returns false on undefined / null", () => {
    expect(assistantMessageHasToolUses(undefined)).toBe(false);
    expect(assistantMessageHasToolUses(null)).toBe(false);
  });

  it("returns false when content is not an array", () => {
    expect(assistantMessageHasToolUses({ content: "not-an-array" })).toBe(false);
  });

  it("returns true even when interleaved with non-tool_use blocks", () => {
    const msg = {
      content: [
        { type: "text", text: "First." },
        { type: "thinking", text: "Pondering." },
        { type: "tool_use", id: "tu_2", name: "Read", input: { file_path: "/x" } },
        { type: "text", text: "Last." },
      ],
    };
    expect(assistantMessageHasToolUses(msg)).toBe(true);
  });

  it("ignores entries that aren't objects or lack a type field", () => {
    const msg = {
      content: [null, "raw-string-not-block", { notAType: true }, { type: "text", text: "ok" }],
    };
    expect(assistantMessageHasToolUses(msg)).toBe(false);
  });
});

/**
 * FRI-127 §7 / AC#10: the result short-circuit, when it lands while a
 * pending-injection break is deferred for an outstanding tool_use, heals the
 * SDK session JSONL mid-session by appending a synthetic tool_result. This
 * exercises the exact heal call the short-circuit makes
 * (`healDanglingToolUseInJsonl`) against a stubbed transcript ending on a
 * dangling tool_use, and pins idempotency so the boot-time recovery (or an
 * SDK-fabricated tool_result arriving later) is a no-op write skip.
 */
describe("mid-session dangling tool_use heal (FRI-127 §7)", () => {
  let fakeHome: string;
  const CWD = "/tmp/heal-wt";
  const SESSION = "sess-heal";
  const TOOL_USE_ID = "tu_dangling";

  beforeEach(() => {
    // Redirect $HOME so the SDK JSONL writes land in a scratch dir instead of
    // touching the operator's real ~/.claude (homedir() reads $HOME on POSIX).
    fakeHome = mkdtempSync(join(tmpdir(), "friday-break-heal-"));
    vi.stubEnv("HOME", fakeHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function writeDanglingTranscript(): string {
    const path = sessionFilePath(CWD, SESSION);
    mkdirSync(dirname(path), { recursive: true });
    const assistant = {
      parentUuid: null,
      isSidechain: false,
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: TOOL_USE_ID, name: "Bash", input: { command: "ls" } }],
      },
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: SESSION,
      cwd: CWD,
      userType: "external",
      entrypoint: "sdk-ts",
      version: "test",
      gitBranch: "HEAD",
    };
    writeFileSync(path, JSON.stringify(assistant) + "\n", "utf8");
    return path;
  }

  it("appends a synthetic is_error tool_result whose tool_use_id matches the dangling tool_use", () => {
    const path = writeDanglingTranscript();

    const result = healDanglingToolUseInJsonl({
      cwd: CWD,
      sessionId: SESSION,
      toolUseId: TOOL_USE_ID,
      healMarker: "[Tool call interrupted by mid-turn break; session continues.]",
    });
    expect(result.written).toBe(true);

    const entries = [...parseEntries(readFileSync(path, "utf8"))];
    const last = entries[entries.length - 1] as {
      type?: string;
      message?: { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean }> };
    };
    expect(last.type).toBe("user");
    const block = last.message?.content?.[0];
    expect(block?.type).toBe("tool_result");
    expect(block?.tool_use_id).toBe(TOOL_USE_ID);
    expect(block?.is_error).toBe(true);
  });

  it("is idempotent: a second heal of the same tool_use_id does not append again", () => {
    const path = writeDanglingTranscript();

    const first = healDanglingToolUseInJsonl({
      cwd: CWD,
      sessionId: SESSION,
      toolUseId: TOOL_USE_ID,
      healMarker: "marker",
    });
    expect(first.written).toBe(true);
    const afterFirst = readFileSync(path, "utf8");
    const linesAfterFirst = [...parseEntries(afterFirst)].length;

    const second = healDanglingToolUseInJsonl({
      cwd: CWD,
      sessionId: SESSION,
      toolUseId: TOOL_USE_ID,
      healMarker: "marker",
    });
    // `hasMatchingToolResult` makes the second call a no-op write skip — the
    // exact guard that protects against boot-time recovery (or an SDK-
    // fabricated tool_result) double-writing.
    expect(second.written).toBe(false);
    expect((second as { reason?: string }).reason).toBe("already-resolved");
    // File unchanged byte-for-byte; no extra synthetic entry.
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
    expect([...parseEntries(readFileSync(path, "utf8"))].length).toBe(linesAfterFirst);
  });

  it("no-ops when the transcript is missing (fresh/cleared session)", () => {
    const result = healDanglingToolUseInJsonl({
      cwd: CWD,
      sessionId: "nonexistent-session",
      toolUseId: TOOL_USE_ID,
      healMarker: "marker",
    });
    expect(result.written).toBe(false);
  });
});
