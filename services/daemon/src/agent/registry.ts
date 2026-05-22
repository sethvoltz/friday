import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  AGENTS_DIR,
  type AgentEntry,
  type AgentStatus,
  type AgentType,
  type ArchiveReason,
  appDir,
  getDb,
  schema,
} from "@friday/shared";

/**
 * FRI-113: status state machine. Every write to `agents.status` flows
 * through `setStatus` below, which checks the (type, current, next)
 * triple against the matrix defined here. Illegal transitions throw
 * `IllegalTransitionError` — see ADR-031.
 *
 * Reading rules:
 *   - Same-status writes (e.g. idle→idle) are no-ops, never illegal.
 *   - `archived` is terminal; the only escape is `unarchiveAgent`, which
 *     uses the privileged `_setStatusUnchecked` helper.
 *   - Orchestrators cannot reach `archived` from any state — this closes
 *     the "friday alive but archived" class of bug surfaced in the
 *     2026-05-22 grill.
 *   - `archive_requested` is in the DB check constraint
 *     (`schema.ts:97`) but NOT yet in the TS `AgentStatus` union
 *     (`agents.ts:5-10`). The intermediate value is only written by the
 *     Zero mutator path; the daemon's LISTEN handler flips it to
 *     `archived` immediately. The FSM treats it as a transient state we
 *     never read; widening the TS union is an explicit ADR-031 follow-up.
 */
type StatusTransitionTable = Readonly<Record<AgentStatus, ReadonlyArray<AgentStatus>>>;

const COMMON_TRANSITIONS: StatusTransitionTable = {
  idle: ["working", "stalled", "error", "archived"],
  working: ["idle", "stalled", "error", "archived"],
  stalled: ["idle", "working", "error", "archived"],
  error: ["idle", "archived"],
  // Terminal. Only `unarchiveAgent` can leave this status, and it uses
  // the privileged unchecked path. Nothing else may.
  archived: [],
};

const ORCHESTRATOR_TRANSITIONS: StatusTransitionTable = {
  idle: ["working", "stalled", "error"],
  working: ["idle", "stalled", "error"],
  stalled: ["idle", "working", "error"],
  error: ["idle"],
  // The orchestrator-not-archivable invariant: no edge into `archived`
  // from anywhere. If a row ever lands at `archived`, the auditor's
  // rule #3 heals it back to `idle` via the unchecked path.
  archived: [],
};

const TRANSITIONS_BY_TYPE: Readonly<Record<AgentType, StatusTransitionTable>> = {
  orchestrator: ORCHESTRATOR_TRANSITIONS,
  builder: COMMON_TRANSITIONS,
  helper: COMMON_TRANSITIONS,
  scheduled: COMMON_TRANSITIONS,
  bare: COMMON_TRANSITIONS,
};

export type IllegalTransitionCode =
  | "ORCHESTRATOR_NOT_ARCHIVABLE"
  | "INVALID_STATUS_TRANSITION"
  | "MISSING_ARCHIVE_REASON"
  | "AGENT_NOT_FOUND";

export class IllegalTransitionError extends Error {
  readonly code: IllegalTransitionCode;
  readonly from: AgentStatus | null;
  readonly to: AgentStatus;
  readonly type: AgentType | null;
  readonly agentName: string;

  constructor(opts: {
    code: IllegalTransitionCode;
    from: AgentStatus | null;
    to: AgentStatus;
    type: AgentType | null;
    name: string;
  }) {
    super(
      `IllegalTransitionError[${opts.code}]: agent="${opts.name}" type=${opts.type ?? "?"} from=${opts.from ?? "?"} to=${opts.to}`,
    );
    this.name = "IllegalTransitionError";
    this.code = opts.code;
    this.from = opts.from;
    this.to = opts.to;
    this.type = opts.type;
    this.agentName = opts.name;
  }
}

/**
 * Pure predicate over the FSM matrix. Exported so the auditor can ask
 * "is this (type, status) the legal resting set for this agent?" without
 * doing a no-op write to provoke the gate.
 */
export function isLegalTransition(
  type: AgentType,
  from: AgentStatus,
  to: AgentStatus,
): boolean {
  if (from === to) return true;
  const allowed = TRANSITIONS_BY_TYPE[type][from] ?? [];
  return allowed.includes(to);
}

export async function listAgents(): Promise<AgentEntry[]> {
  const db = getDb();
  const rows = await db.select().from(schema.agents);
  return rows.map(rowToEntry);
}

export async function getAgent(name: string): Promise<AgentEntry | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export interface RegisterInput {
  name: string;
  type: AgentType;
  parentName?: string;
  worktreePath?: string;
  branch?: string;
  ticketId?: string;
  appId?: string;
  /**
   * ADR-022: free-text rationale recorded when a non-orchestrator (a
   * Builder or Helper) spawned this agent. The daemon's spawn handler
   * requires this to be non-empty for builder/helper callers; orchestrator
   * spawns leave it null. Watchdog refork preserves the prior row's value
   * so the audit trail survives recovery (FRI-102 AC #11).
   */
  spawnReason?: string | null;
}

export async function registerAgent(input: RegisterInput): Promise<AgentEntry> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(schema.agents)
    .values({
      name: input.name,
      type: input.type,
      status: "idle",
      parentName: input.parentName ?? null,
      worktreePath: input.worktreePath ?? null,
      branch: input.branch ?? null,
      ticketId: input.ticketId ?? null,
      appId: input.appId ?? null,
      spawnReason: input.spawnReason ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.agents.name,
      set: { status: "idle", updatedAt: now },
    });
  const got = await getAgent(input.name);
  if (!got) throw new Error(`registerAgent: row vanished after insert: ${input.name}`);
  return got;
}

/**
 * Read the raw `spawn_reason` column for an agent. AgentEntry is the
 * user-facing wire shape and deliberately omits this field, so the
 * watchdog refork (and any future audit consumer) reads it directly via
 * this helper. Returns null when the agent doesn't exist or was spawned
 * by the orchestrator (no reason required, column stays null).
 */
export async function getSpawnReason(name: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ spawnReason: schema.agents.spawnReason })
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  return rows[0]?.spawnReason ?? null;
}

/**
 * Set the owning app id for an existing agent row. Used by the apps
 * installer when rebinding a previously-unaffiliated or other-app agent
 * to a new owner. Pass `null` to clear.
 */
export async function setAppId(
  name: string,
  appId: string | null,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agents)
    .set({ appId, updatedAt: new Date() })
    .where(eq(schema.agents.name, name));
}

/**
 * Read the raw `app_id` for an agent. Returns null when the agent
 * doesn't exist or isn't owned by an app.
 */
export async function getAppId(name: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ appId: schema.agents.appId })
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  return rows[0]?.appId ?? null;
}

/**
 * FRI-113: privileged unchecked status write. Bypasses the FSM gate.
 * Only legitimate callers are (a) `unarchiveAgent` (terminal-state
 * escape, which the FSM matrix deliberately does not permit) and (b)
 * the invariants auditor rule #3 (healing FSM violations writes status
 * transitions the matrix forbids — e.g. orchestrator-archived → idle).
 *
 * Internal to this module. Do NOT export. Callers that need the gated
 * path use `setStatus`; callers that need the unchecked path live in
 * this file or call `unarchiveAgent`.
 */
async function _setStatusUnchecked(
  name: string,
  status: AgentStatus,
  opts: { archiveReason?: ArchiveReason | null } = {},
): Promise<void> {
  const db = getDb();
  const setShape: {
    status: AgentStatus;
    updatedAt: Date;
    archiveReason?: ArchiveReason | null;
  } = { status, updatedAt: new Date() };
  if (opts.archiveReason !== undefined) {
    setShape.archiveReason = opts.archiveReason;
  }
  await db
    .update(schema.agents)
    .set(setShape)
    .where(eq(schema.agents.name, name));
}

/**
 * Privileged unchecked write for the invariants auditor's rule #3.
 * Exported so `invariants.ts` can heal FSM violations the gate forbids
 * (e.g. orchestrator-archived → idle). NO other caller should reach
 * for this — it is the explicit escape hatch documented in ADR-031.
 *
 * The shape forces callers to acknowledge the escape: the `auditorHeal`
 * key in the opts object is the marker future readers grep for to find
 * every privileged use site.
 */
export async function _auditorHealStatusUnchecked(
  name: string,
  status: AgentStatus,
  opts: {
    auditorHeal: true;
    clearArchiveReason?: boolean;
  },
): Promise<void> {
  void opts.auditorHeal; // shape-only marker
  await _setStatusUnchecked(name, status, {
    archiveReason: opts.clearArchiveReason ? null : undefined,
  });
}

/**
 * FRI-113: gated status write. Validates the (type, current, next)
 * triple against the FSM matrix. Throws `IllegalTransitionError` on
 * any invalid transition; writes `archive_reason` atomically when the
 * target is `archived`.
 *
 * `opts.archiveReason` is REQUIRED when `status === "archived"`. Any
 * other target ignores the field.
 */
export async function setStatus(
  name: string,
  status: AgentStatus,
  opts: { archiveReason?: ArchiveReason } = {},
): Promise<void> {
  const row = await getAgent(name);
  if (!row) {
    // Matches pre-FSM behavior: a bare UPDATE that matches no rows is
    // a silent no-op. Production callers should never reach this with
    // a real-but-missing agent (the live worker map and dispatch
    // surface keep them aligned), but worker IPC handlers and test
    // doubles occasionally fire setStatus against an unregistered
    // name. Throwing would be a hard regression; log-and-no-op keeps
    // the new contract narrow to actual transition violations.
    return;
  }
  if (!isLegalTransition(row.type, row.status, status)) {
    const code: IllegalTransitionCode =
      row.type === "orchestrator" && status === "archived"
        ? "ORCHESTRATOR_NOT_ARCHIVABLE"
        : "INVALID_STATUS_TRANSITION";
    throw new IllegalTransitionError({
      code,
      from: row.status,
      to: status,
      type: row.type,
      name,
    });
  }
  if (status === "archived" && !opts.archiveReason) {
    throw new IllegalTransitionError({
      code: "MISSING_ARCHIVE_REASON",
      from: row.status,
      to: status,
      type: row.type,
      name,
    });
  }
  await _setStatusUnchecked(name, status, {
    archiveReason: status === "archived" ? opts.archiveReason : undefined,
  });
}

export async function setSession(
  name: string,
  sessionId: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agents)
    .set({ sessionId, updatedAt: new Date() })
    .where(eq(schema.agents.name, name));
}

export async function clearSession(name: string): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agents)
    .set({ sessionId: null, updatedAt: new Date() })
    .where(eq(schema.agents.name, name));
}

/**
 * Transition an agent to `archived` with a required reason. The reason
 * is persisted to the `archive_reason` column atomically with the
 * status write. Goes through the FSM gate, so orchestrator-archive
 * attempts throw `IllegalTransitionError` with code
 * `ORCHESTRATOR_NOT_ARCHIVABLE`.
 */
export async function archiveAgent(
  name: string,
  opts: { reason: ArchiveReason },
): Promise<void> {
  await setStatus(name, "archived", { archiveReason: opts.reason });
}

/**
 * Reverse of `archiveAgent`. Flips an `archived` row back to `idle`,
 * preserving `sessionId` so previously-recorded chat history continues
 * into the un-archived agent. Used by the apps installer on reinstall.
 *
 * Uses the privileged unchecked write because the FSM matrix has no
 * `archived → idle` edge (terminal state). This is the ONLY non-auditor
 * caller that bypasses the gate.
 */
export async function unarchiveAgent(name: string): Promise<void> {
  const row = await getAgent(name);
  if (!row) throw new Error(`unarchiveAgent: no agent named "${name}"`);
  if (row.status !== "archived") {
    throw new Error(
      `unarchiveAgent: "${name}" is not archived (status=${row.status})`,
    );
  }
  await _setStatusUnchecked(row.name, "idle", { archiveReason: null });
}

/**
 * Hard-remove a registry row. Reserved for stub rows that have no history
 * (e.g. a scheduled-agent stub created by `schedule_upsert` whose schedule
 * was deleted before the first fire). The general policy is preserve-over-
 * delete; callers must verify the row has no session and no blocks first.
 */
export async function deleteAgent(name: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.agents).where(eq(schema.agents.name, name));
}

function rowToEntry(r: typeof schema.agents.$inferSelect): AgentEntry {
  const base = {
    name: r.name,
    type: r.type as AgentType,
    status: r.status as AgentStatus,
    sessionId: r.sessionId ?? undefined,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
  switch (base.type) {
    case "orchestrator":
      return { ...base, type: "orchestrator" } as AgentEntry;
    case "builder":
      return {
        ...base,
        type: "builder",
        parentName: r.parentName!,
        worktreePath: r.worktreePath!,
        branch: r.branch ?? undefined,
        ticketId: r.ticketId ?? undefined,
      } as AgentEntry;
    case "helper":
      return {
        ...base,
        type: "helper",
        parentName: r.parentName!,
      } as AgentEntry;
    case "scheduled":
      return {
        ...base,
        type: "scheduled",
        taskPrompt: "",
        paused: false,
      } as AgentEntry;
    case "bare":
      return {
        ...base,
        type: "bare",
        parentName: r.parentName ?? undefined,
      } as AgentEntry;
  }
}

/**
 * Resolve the cwd a worker should run under for a given agent. Branch order:
 *
 *   1. Builders → their git worktree (workspace containment, Constitution rule).
 *   2. App-installed agents → `~/.friday/apps/<id>/` (the app owns its dir).
 *   3. Everyone else → `~/.friday/agents/<name>/` (FRI-61 per-agent home).
 *
 * Centralized so every dispatch path (initial create, mail-driven,
 * watchdog refork, recovery) agrees. Pre-FRI-61 the fallback was
 * `process.cwd()`, which silently broke session resume when the daemon's
 * launch cwd changed (e.g. dev-tree → Homebrew). The SDK encodes cwd
 * into the JSONL transcript path, so any divergence vs. previous fires
 * makes the prior session unreachable.
 *
 * AgentEntry doesn't carry `appId` (it's not part of the user-facing wire
 * shape), so we re-read it via `getAppId(a.name)` when the appDir branch
 * needs to fire.
 */
export async function workingDirectoryFor(a: AgentEntry): Promise<string> {
  if ("worktreePath" in a && a.worktreePath) return a.worktreePath;
  const appId = await getAppId(a.name);
  if (appId) return appDir(appId);
  const home = join(AGENTS_DIR, a.name);
  mkdirSync(home, { recursive: true });
  return home;
}
