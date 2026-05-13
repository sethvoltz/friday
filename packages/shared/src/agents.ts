import type { AgentTypeName } from "./config.js";

export type AgentType = AgentTypeName;

export type AgentStatus =
  | "idle"
  | "working"
  | "stalled"
  | "error"
  | "archived";

export interface BaseAgentEntry {
  name: string;
  type: AgentType;
  status: AgentStatus;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorEntry extends BaseAgentEntry {
  type: "orchestrator";
}

export interface BuilderEntry extends BaseAgentEntry {
  type: "builder";
  parentName: string;
  worktreePath: string;
  branch?: string;
  ticketId?: string;
}

export interface HelperEntry extends BaseAgentEntry {
  type: "helper";
  parentName: string;
}

export interface ScheduledEntry extends BaseAgentEntry {
  type: "scheduled";
  cron?: string;
  runAt?: string;
  taskPrompt: string;
  paused: boolean;
}

export interface BareEntry extends BaseAgentEntry {
  type: "bare";
  /** Bares may be spawned by the user (`/scratch`) or implicitly. */
  parentName?: string;
}

export type AgentEntry =
  | OrchestratorEntry
  | BuilderEntry
  | HelperEntry
  | ScheduledEntry
  | BareEntry;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidAgentName(name: string): boolean {
  return NAME_RE.test(name);
}

export function assertValidAgentName(name: string): void {
  if (!isValidAgentName(name)) {
    throw new Error(
      `invalid agent name "${name}": must match ${NAME_RE.toString()}`,
    );
  }
}
