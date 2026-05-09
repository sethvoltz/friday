import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export interface TurnRow {
  id: number;
  sessionId: string;
  agentName: string | null;
  turnIndex: number;
  ts: number;
  role: string;
  kind: string;
  contentJson: string;
  sourceFile: string;
  sourceByteOff: number;
  lastEventSeq: number;
}

/**
 * Insert a turn parsed from Claude's JSONL. Idempotent on (sessionId, turnIndex).
 */
export function upsertTurn(row: Omit<TurnRow, "id">): TurnRow {
  const db = getDb();
  const existing = db
    .select()
    .from(schema.turns)
    .where(
      and(
        eq(schema.turns.sessionId, row.sessionId),
        eq(schema.turns.turnIndex, row.turnIndex),
      ),
    )
    .get();
  if (existing) {
    db.update(schema.turns)
      .set({
        contentJson: row.contentJson,
        ts: row.ts,
        role: row.role,
        kind: row.kind,
        sourceFile: row.sourceFile,
        sourceByteOff: row.sourceByteOff,
        lastEventSeq: row.lastEventSeq,
        agentName: row.agentName,
      })
      .where(eq(schema.turns.id, existing.id))
      .run();
    return { ...existing, ...row, id: existing.id } as TurnRow;
  }
  const inserted = db
    .insert(schema.turns)
    .values({
      sessionId: row.sessionId,
      agentName: row.agentName,
      turnIndex: row.turnIndex,
      ts: row.ts,
      role: row.role,
      kind: row.kind,
      contentJson: row.contentJson,
      sourceFile: row.sourceFile,
      sourceByteOff: row.sourceByteOff,
      lastEventSeq: row.lastEventSeq,
    })
    .returning()
    .get();
  return inserted as TurnRow;
}

export function bumpTurnSeq(turnId: number, seq: number): void {
  const db = getDb();
  db.update(schema.turns)
    .set({ lastEventSeq: seq })
    .where(eq(schema.turns.id, turnId))
    .run();
}

export interface ListTurnsOpts {
  sessionId?: string;
  agentName?: string;
  beforeId?: number;
  afterId?: number;
  limit?: number;
}

export interface AgentSessionSummary {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  turnCount: number;
}

/**
 * Distinct sessions for an agent, sorted most-recent first. Used by the
 * sidebar to expand an agent row into its prior sessions list.
 */
export function listAgentSessions(agentName: string): AgentSessionSummary[] {
  const db = getDb();
  const rows = db
    .select({
      sessionId: schema.turns.sessionId,
      firstTs: sql<number>`MIN(${schema.turns.ts})`,
      lastTs: sql<number>`MAX(${schema.turns.ts})`,
      turnCount: sql<number>`COUNT(*)`,
    })
    .from(schema.turns)
    .where(eq(schema.turns.agentName, agentName))
    .groupBy(schema.turns.sessionId)
    .orderBy(desc(sql<number>`MAX(${schema.turns.ts})`))
    .all();
  return rows as AgentSessionSummary[];
}

/**
 * Distinct session counts keyed by agent name. One query supplying counts
 * for the entire registry, so /api/agents can decide which rows show an
 * expand-history button without N+1 hits.
 */
export function sessionCountsByAgent(): Record<string, number> {
  const db = getDb();
  const rows = db
    .select({
      agentName: schema.turns.agentName,
      count: sql<number>`COUNT(DISTINCT ${schema.turns.sessionId})`,
    })
    .from(schema.turns)
    .where(sql`${schema.turns.agentName} IS NOT NULL`)
    .groupBy(schema.turns.agentName)
    .all();
  const out: Record<string, number> = {};
  for (const r of rows as Array<{ agentName: string | null; count: number }>) {
    if (r.agentName) out[r.agentName] = r.count;
  }
  return out;
}

export function listTurns(opts: ListTurnsOpts = {}): TurnRow[] {
  const db = getDb();
  const conds = [];
  if (opts.sessionId) conds.push(eq(schema.turns.sessionId, opts.sessionId));
  if (opts.agentName) conds.push(eq(schema.turns.agentName, opts.agentName));
  if (opts.beforeId !== undefined) conds.push(lt(schema.turns.id, opts.beforeId));
  if (opts.afterId !== undefined) conds.push(gt(schema.turns.id, opts.afterId));
  const base = db.select().from(schema.turns);
  const filtered = conds.length > 0 ? base.where(and(...conds)) : base;
  return filtered
    .orderBy(
      opts.afterId !== undefined ? asc(schema.turns.id) : desc(schema.turns.id),
    )
    .limit(opts.limit ?? 50)
    .all() as TurnRow[];
}
