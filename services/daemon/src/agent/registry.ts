import { eq } from "drizzle-orm";
import {
  type AgentEntry,
  type AgentStatus,
  type AgentType,
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
  if ("worktreePath" in a && a.worktreePath) return a.worktreePath;
  return process.cwd();
}
