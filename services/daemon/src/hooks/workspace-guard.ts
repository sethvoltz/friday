import type { HookContextMap, HookResultMap } from "@friday/shared";
import { checkToolCall } from "../agent/workspace-guard.js";

export async function workspaceGuardHook(
  ctx: HookContextMap["before_tool_call"],
): Promise<HookResultMap["before_tool_call"] | void> {
  const reason = checkToolCall(ctx.workspacePath, ctx.toolName, ctx.toolInput);
  if (!reason) return;
  return { deny: { reason } };
}
