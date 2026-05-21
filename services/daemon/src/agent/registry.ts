import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  AGENTS_DIR,
  type AgentEntry,
  type AgentStatus,
  type AgentType,
  appDir,
  getDb,
  schema,
} from "@friday/shared";

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

export async function setStatus(
  name: string,
  status: AgentStatus,
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.agents)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.agents.name, name));
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

export async function archiveAgent(name: string): Promise<void> {
  await setStatus(name, "archived");
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
export async function unarchiveAgent(name: string): Promise<void> {
  const row = await getAgent(name);
  if (!row) throw new Error(`unarchiveAgent: no agent named "${name}"`);
  if (row.status !== "archived") {
    throw new Error(
      `unarchiveAgent: "${name}" is not archived (status=${row.status})`,
    );
  }
  await setStatus(name, "idle");
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
