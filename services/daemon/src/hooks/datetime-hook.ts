import { renderLocalDatetime } from "@friday/shared";
import type { HookContextMap, HookResultMap } from "@friday/shared";

export async function datetimeHook(
  _ctx: HookContextMap["before_prompt_build"],
): Promise<HookResultMap["before_prompt_build"]> {
  return { appendSystemPrompt: renderLocalDatetime() };
}
