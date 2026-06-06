import type { HookContextMap, HookResultMap } from "@friday/shared";
import { checkToolCall } from "../agent/workspace-guard.js";

export async function workspaceGuardHook(
  ctx: HookContextMap["before_tool_call"],
): Promise<HookResultMap["before_tool_call"] | void> {
  // FRI-16: forward the caller-selected strictness (planner-in-builder-
  // worktree = "middle"); `checkToolCall` defaults an absent mode to "strict".
  const reason = checkToolCall(ctx.workspacePath, ctx.toolName, ctx.toolInput, { mode: ctx.mode });
  if (!reason) return;
  return { deny: { reason } };
}
