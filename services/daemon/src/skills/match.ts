import { loadSkills, skillsForAgent, type Skill } from "@friday/shared";
import type { AgentEntry } from "@friday/shared";

/**
 * Detect a `/<skill-name> ...args` invocation at the start of a user message.
 * Returns the matched Skill plus the remaining args (the user message minus
 * the slash command), or null if no match. Filters by agent type.
 */
export function matchSkillInvocation(
  text: string,
  agentType: AgentEntry["type"],
): { skill: Skill; userText: string } | null {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1];
  const rest = (m[2] ?? "").trim();
  const all = loadSkills();
  const eligible = skillsForAgent(all, agentType);
  const skill = eligible.find((s) => s.name === name);
  if (!skill) return null;
  return { skill, userText: rest };
}
