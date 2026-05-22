import type { HookContextMap, HookResultMap } from "@friday/shared";
import { safeRecall, type RecallIntent } from "../agent/recall.js";

export async function memoryRecallHook(
  ctx: HookContextMap["before_prompt_build"],
): Promise<HookResultMap["before_prompt_build"] | void> {
  const block = await safeRecall(ctx.intent, ctx.intentTag as RecallIntent);
  if (!block) return;
  return { appendSystemPrompt: block };
}
