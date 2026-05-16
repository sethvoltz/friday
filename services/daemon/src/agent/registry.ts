import { eq } from "drizzle-orm";
import {
  type AgentEntry,
  type AgentStatus,
  type AgentType,
  appDir,
  getDb,
  schema,
} from "@friday/shared";

export function listAgents(): AgentEntry[] {
  const db = getDb();
  return db.select().from(schema.agents).all().map(rowToEntry);
}

export function getAgent(name: string): AgentEntry | null {
  const db = getDb();
  const r = db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .get();
  return r ? rowToEntry(r) : null;
}

export interface RegisterInput {
  name: string;
  type: AgentType;
  parentName?: string;
  worktreePath?: string;
  branch?: string;
  ticketId?: string;
  appId?: string;
}

export function registerAgent(input: RegisterInput): AgentEntry {
  const db = getDb();
  const now = new Date();
  db.insert(schema.agents)
    .values({
      name: input.name,
      type: input.type,
      status: "idle",
      parentName: input.parentName ?? null,
      worktreePath: input.worktreePath ?? null,
      branch: input.branch ?? null,
      ticketId: input.ticketId ?? null,
      appId: input.appId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.agents.name,
      set: { status: "idle", updatedAt: now },
    })
    .run();
  return getAgent(input.name)!;
}

/**
 * Set the owning app id for an existing agent row. Used by the apps
 * installer when rebinding a previously-unaffiliated or other-app agent
 * to a new owner. Pass `null` to clear.
 */
export function setAppId(name: string, appId: string | null): void {
  const db = getDb();
  db.update(schema.agents)
    .set({ appId, updatedAt: new Date() })
    .where(eq(schema.agents.name, name))
    .run();
}

/**
 * Read the raw `app_id` for an agent. Returns null when the agent
 * doesn't exist or isn't owned by an app.
 */
export function getAppId(name: string): string | null {
  const db = getDb();
  const r = db
    .select({ appId: schema.agents.appId })
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .get();
  return r?.appId ?? null;
}

export function setStatus(name: string, status: AgentStatus): void {
  const db = getDb();
  db.update(schema.agents)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.agents.name, name))
    .run();
}

export function setSession(name: string, sessionId: string): void {
  const db = getDb();
  db.update(schema.agents)
    .set({ sessionId, updatedAt: new Date() })
    .where(eq(schema.agents.name, name))
    .run();
}

export function clearSession(name: string): void {
  const db = getDb();
  db.update(schema.agents)
    .set({ sessionId: null, updatedAt: new Date() })
    .where(eq(schema.agents.name, name))
    .run();
}

export function archiveAgent(name: string): void {
  setStatus(name, "archived");
}

/**
 * Reverse of `archiveAgent`. Flips an `archived` row back to `idle`,
 * preserving `sessionId` so previously-recorded chat history continues
 * into the un-archived agent. Used by the apps installer on reinstall.
 *
 * Throws if the row is missing or in any non-archived status — the
 * lifecycle path keeps its own guard against a worker-exit handler
 * stomping an archived terminal state, so callers shouldn't be using
 * this to clobber other transitions.
 */
export function unarchiveAgent(name: string): void {
  const row = getAgent(name);
  if (!row) throw new Error(`unarchiveAgent: no agent named "${name}"`);
  if (row.status !== "archived") {
    throw new Error(
      `unarchiveAgent: "${name}" is not archived (status=${row.status})`,
    );
  }
  setStatus(name, "idle");
}

/**
 * Hard-remove a registry row. Reserved for stub rows that have no history
 * (e.g. a scheduled-agent stub created by `schedule_upsert` whose schedule
 * was deleted before the first fire). The general policy is preserve-over-
 * delete; callers must verify the row has no session and no blocks first.
 */
export function deleteAgent(name: string): void {
  const db = getDb();
  db.delete(schema.agents).where(eq(schema.agents.name, name)).run();
}

function rowToEntry(r: typeof schema.agents.$inferSelect): AgentEntry {
  const base = {
    name: r.name,
    type: r.type as AgentType,
    status: r.status as AgentStatus,
    sessionId: r.sessionId ?? undefined,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
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
 * Resolve the cwd a worker should run under for a given agent. Builders run
 * inside their git worktree; everything else runs under the daemon's cwd.
 * Centralized here so all dispatch paths (initial create, mail-driven,
 * watchdog refork, recovery) agree — divergence means the SDK's JSONL
 * transcript ends up in a different `~/.claude/projects/<encoded-cwd>/`
 * directory than the mirror is watching, which silently drops history.
 */
export function workingDirectoryFor(a: AgentEntry): string {
  // Workspace containment is the stronger Constitution rule: builders run
  // inside their worktree even if a future ticket ever surfaces builders
  // under an app. AgentEntry doesn't carry `appId` (it's not part of the
  // user-facing wire shape), so we re-read the row when only the
  // base-typed entry is in hand.
  if ("worktreePath" in a && a.worktreePath) return a.worktreePath;
  const appId = getAppId(a.name);
  if (appId) return appDir(appId);
  return process.cwd();
}
