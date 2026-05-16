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

import { describe, expect, it } from "vitest";
import { assistantMessageHasToolUses } from "./worker.js";

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
      content: [
        null,
        "raw-string-not-block",
        { notAType: true },
        { type: "text", text: "ok" },
      ],
    };
    expect(assistantMessageHasToolUses(msg)).toBe(false);
  });
});
