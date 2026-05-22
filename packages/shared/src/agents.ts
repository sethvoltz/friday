import type { AgentTypeName } from "./config.js";

export type AgentType = AgentTypeName;

export type AgentStatus =
  | "idle"
  | "working"
  | "stalled"
  | "error"
  | "archived";

/**
 * Terminal reason captured when an agent transitions to `archived`.
 *
 * - `completed` — orchestrator MCP `agent_archive` after a successful build;
 *   maps the linked Friday ticket to `done` and Linear state `completed`.
 * - `abandoned` — REST archive, boot-time orphan-worktree sweep, invariants
 *   auditor's orphan sweep, `/archive` slash command default; maps the
 *   linked ticket to `closed` and Linear state `canceled`.
 * - `failed` — orchestrator MCP when the agent errored irrecoverably;
 *   maps to `closed` + failure comment / Linear `canceled`.
 *
 * Forced reforks (`/clear`, watchdog refork) go through `forceWorkerRefork`
 * and never touch the archive write path — that is why the union has no
 * `refork` variant.
 */
export type ArchiveReason = "completed" | "abandoned" | "failed";

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
