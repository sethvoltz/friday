import type { HookContextMap, HookResultMap } from "@friday/shared";

export async function builderTrailerHook(
  ctx: HookContextMap["agent:bootstrap"],
): Promise<HookResultMap["agent:bootstrap"] | void> {
  if (ctx.agentType !== "builder") return;
  if (!ctx.workingDirectory) return;
  // Worktree containment — the original FRI-78 trailer.
  let appendSystemPrompt = `You are running in a git worktree at \`${ctx.workingDirectory}\` on branch \`${ctx.branch ?? "<unknown>"}\`. **Do not read, write, or modify files outside this directory.** All Bash commands run with this directory as cwd by default; do not \`cd\` outside it.`;

  // FRI-127 §4 (closes the FRI-71 gap): record the original mission verbatim
  // so a builder rebooted via mail-wake still knows what it was spawned to do,
  // plus the parent it must mail back when finished.
  if (ctx.spawnPrompt) {
    appendSystemPrompt += `\n\nYour task: ${ctx.spawnPrompt}`;
  }
  if (ctx.parentName) {
    appendSystemPrompt += `\n\nWhen you finish, mail your parent \`${ctx.parentName}\` with the result (\`mail_send({to: "${ctx.parentName}", body: …})\`). Without that mail your parent never learns you're done.`;
  }

  return { appendSystemPrompt };
}
