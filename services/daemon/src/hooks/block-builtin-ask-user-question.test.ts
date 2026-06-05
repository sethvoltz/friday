/**
 * FRI-152 — pin the PreToolUse deny semantics for the built-in
 * `AskUserQuestion` tool. The model-visible reason string is part of the
 * contract (it instructs the model to retry through
 * `mcp__friday-elicitation__ask_user`), so we assert the exact string,
 * not "contains 'AskUserQuestion'".
 */

import { describe, expect, it } from "vitest";
import {
  ASK_USER_QUESTION_BUILTIN_DENY_REASON,
  denyBuiltinAskUserQuestion,
} from "./block-builtin-ask-user-question.js";

describe("denyBuiltinAskUserQuestion", () => {
  it("returns the canonical deny reason for the literal built-in name", () => {
    expect(denyBuiltinAskUserQuestion("AskUserQuestion")).toBe(
      ASK_USER_QUESTION_BUILTIN_DENY_REASON,
    );
  });

  it("returns undefined for any other tool name (so the rest of PreToolUse falls through)", () => {
    expect(denyBuiltinAskUserQuestion("mcp__friday-elicitation__ask_user")).toBeUndefined();
    expect(denyBuiltinAskUserQuestion("Bash")).toBeUndefined();
    expect(denyBuiltinAskUserQuestion("Read")).toBeUndefined();
    expect(denyBuiltinAskUserQuestion("askUserQuestion")).toBeUndefined();
    expect(denyBuiltinAskUserQuestion("")).toBeUndefined();
  });

  it("reason names the MCP replacement so the model can retry through the right path", () => {
    expect(ASK_USER_QUESTION_BUILTIN_DENY_REASON).toContain("mcp__friday-elicitation__ask_user");
    expect(ASK_USER_QUESTION_BUILTIN_DENY_REASON).toContain("not available in this environment");
  });
});
