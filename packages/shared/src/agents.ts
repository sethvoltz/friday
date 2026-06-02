import type { AgentTypeName } from "./config.js";

export type AgentType = AgentTypeName;

/**
 * FRI-117 follow-up (formerly FRI-119 #1): the TS union now matches
 * `packages/shared/src/db/schema.ts:97`'s check constraint exactly.
 * `archive_requested` is the transient state the Zero mutator path
 * writes; the daemon's `archive-listener` flips it to `archived`
 * immediately. The FSM gate in `registry.setStatus` treats it as a
 * transient state observers don't read at rest — but typing the union
 * exhaustively means new code paths that DO observe it can do so
 * via the type system instead of by stringly-typed surprise.
 */
export type AgentStatus = "idle" | "working" | "stalled" | "archived" | "archive_requested";

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
    throw new Error(`invalid agent name "${name}": must match ${NAME_RE.toString()}`);
  }
}
