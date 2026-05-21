/**
 * Renders an agent's pinned memories into a `# Pinned facts` section for
 * its system prompt (FRI-61).
 *
 * Distinct from FTS recall: this fires unconditionally at prompt-assembly
 * time so the agent sees its pinned facts every turn, regardless of what
 * the user (or mail) wrote. Used today for friday's repo path; the same
 * surface generalizes to any always-include per-agent fact.
 */

import { listPinnedForAgent } from "@friday/memory";

export async function renderPinnedFacts(agentName: string): Promise<string> {
  const pins = await listPinnedForAgent(agentName);
  if (pins.length === 0) return "";
  return [
    "# Pinned facts",
    "",
    "Authoritative facts pinned for this agent. Treat as ground truth; do not re-derive or ask.",
    "",
    ...pins.map((p) => `- **${p.title}**: ${p.content.trim()}`),
  ].join("\n");
}
