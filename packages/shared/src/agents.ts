import { join } from "node:path";
import { FRIDAY_DIR } from "./config.js";

export const AGENTS_PATH = join(FRIDAY_DIR, "agents.json");
export const REPOS_DIR = join(FRIDAY_DIR, "repos");

export type AgentType = "orchestrator" | "builder" | "agent";
export type AgentStatus = "active" | "idle" | "destroyed";

export interface OrchestratorEntry {
  type: "orchestrator";
  sessionId: string | null;
  status: AgentStatus;
  createdAt: string;
  children: string[];
}

export interface BuilderEntry {
  type: "builder";
  parent: string;
  sessionId: string | null;
  status: AgentStatus;
  workspace: string;
  epicId: string | null;
  createdAt: string;
  children: string[];
}

export interface AgentEntry {
  type: "agent";
  parent: string;
  sessionId: string | null;
  status: AgentStatus;
  taskId: string | null;
  cwd: string;
  createdAt: string;
}

export type RegistryEntry = OrchestratorEntry | BuilderEntry | AgentEntry;

export interface AgentRegistry {
  [name: string]: RegistryEntry;
}

/**
 * Validate an agent name: lowercase alphanumeric, hyphens, no leading/trailing hyphen.
 */
export function isValidAgentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && name.length >= 2;
}

/**
 * Generate a namespaced agent name.
 * Builders: "builder-<project>"
 * Agents: "agent-<parent-project>-<descriptor>"
 */
export function buildAgentName(
  type: "builder" | "agent",
  parentName: string,
  descriptor: string
): string {
  const safe = descriptor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (type === "builder") {
    return `builder-${safe}`;
  }
  // For agents, namespace under parent. Strip "builder-" prefix from parent for brevity.
  const parentShort = parentName.replace(/^builder-/, "");
  return `agent-${parentShort}-${safe}`;
}
