import type { HookContextMap, HookResultMap } from "@friday/shared";

export async function skillContextHook(
  ctx: HookContextMap["before_prompt_build"],
): Promise<HookResultMap["before_prompt_build"] | void> {
  const match = ctx.skillMatch;
  if (!match) return;
  const allowedTools = match.skill.allowedTools;
  return {
    appendSystemPrompt: `<skill-context name="${match.skill.name}">\n${match.skill.body}\n</skill-context>`,
    allowedToolsOverride:
      allowedTools && allowedTools.length > 0 ? allowedTools : undefined,
  };
}
