import type { HookContextMap, HookResultMap } from "@friday/shared";

export async function builderTrailerHook(
  ctx: HookContextMap["agent:bootstrap"],
): Promise<HookResultMap["agent:bootstrap"] | void> {
  if (ctx.agentType !== "builder") return;
  if (!ctx.workingDirectory) return;
  return {
    appendSystemPrompt: `You are running in a git worktree at \`${ctx.workingDirectory}\` on branch \`${ctx.branch ?? "<unknown>"}\`. **Do not read, write, or modify files outside this directory.** All Bash commands run with this directory as cwd by default; do not \`cd\` outside it.`,
  };
}
