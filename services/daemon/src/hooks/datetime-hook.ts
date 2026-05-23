import { renderLocalDatetime } from "@friday/shared";
import type { HookContextMap, HookResultMap } from "@friday/shared";

export function datetimeHook(
  _ctx: HookContextMap["before_prompt_build"],
): HookResultMap["before_prompt_build"] {
  return { appendSystemPrompt: renderLocalDatetime() };
}
