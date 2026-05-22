import { runHooks, type SkillMatch } from "@friday/shared";
import type { RecallIntent } from "./recall.js";

export interface ComposeDispatchPromptArgs {
  intentText: string;
  intentTag: RecallIntent;
  body: string;
  agentType: string;
  baseSystemPrompt: string;
  skillMatch?: SkillMatch;
}

export interface ComposedDispatchPrompt {
  body: string;
  systemPrompt: string;
  allowedToolsOverride?: string[];
}

export async function composeDispatchPrompt(
  args: ComposeDispatchPromptArgs,
): Promise<ComposedDispatchPrompt> {
  const results = await runHooks("before_prompt_build", {
    intent: args.intentText,
    intentTag: args.intentTag,
    body: args.body,
    agentType: args.agentType,
    skillMatch: args.skillMatch,
  });
  let body = args.body;
  let systemPrompt = args.baseSystemPrompt;
  let allowedToolsOverride: string[] | undefined;
  for (const r of results) {
    if (r.prependBody) body = `${r.prependBody}\n\n${body}`;
    if (r.appendSystemPrompt) {
      systemPrompt = `${systemPrompt}\n\n${r.appendSystemPrompt}`;
    }
    if (r.allowedToolsOverride) allowedToolsOverride = r.allowedToolsOverride;
  }
  return { body, systemPrompt, allowedToolsOverride };
}
