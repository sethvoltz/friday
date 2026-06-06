import type { Skill } from "../skills.js";

export type HookEvent =
  | "agent:bootstrap"
  | "before_prompt_build"
  | "before_tool_call"
  | "before_compaction";

export interface SkillMatch {
  skill: Skill;
  userText: string;
}

export interface HookContextMap {
  "agent:bootstrap": {
    agentName: string;
    agentType: string;
    workingDirectory: string;
    branch?: string;
    /** FRI-127 §4: the spawning agent's name, threaded so the builder
     *  bootstrap trailer can tell the builder who to mail back. */
    parentName?: string;
    /** FRI-127 §4: the verbatim first-turn prompt the parent spawned this
     *  agent with, so a mail-woken builder retains its original mission
     *  (closes the FRI-71 gap). */
    spawnPrompt?: string;
  };
  before_prompt_build: {
    intent: string;
    intentTag: "user_chat" | "mail" | "scheduled" | "scratch" | "agent_spawn" | "compact";
    body: string;
    agentType: string;
    skillMatch?: SkillMatch;
  };
  before_tool_call: {
    workspacePath: string;
    toolName: string | undefined;
    toolInput: Record<string, unknown>;
  };
  before_compaction: {
    sessionId: string;
    transcriptPath: string;
    trigger: "manual" | "auto";
  };
}

export interface HookResultMap {
  "agent:bootstrap": { appendSystemPrompt?: string };
  before_prompt_build: {
    prependBody?: string;
    appendSystemPrompt?: string;
    allowedToolsOverride?: string[];
  };
  before_tool_call: { deny?: { reason: string } };
  before_compaction: { snapshot?: unknown };
}

export type HookHandler<E extends HookEvent> = (
  ctx: HookContextMap[E],
) => Promise<HookResultMap[E] | void>;
