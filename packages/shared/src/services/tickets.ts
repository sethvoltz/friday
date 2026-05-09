import { and, desc, eq } from "drizzle-orm";
import { getDb, getRawDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export type TicketStatus =
  | "open"
  | "in_progress"
  | "done"
  | "blocked"
  | "closed";
export type TicketKind = "task" | "epic" | "bug" | "chore";

export interface Ticket {
  id: string; // FRI-1234
  title: string;
  body: string | null;
  status: TicketStatus;
  kind: TicketKind;
  assignee: string | null;
  meta: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTicketInput {
  title: string;
  body?: string;
  status?: TicketStatus;
  kind?: TicketKind;
  assignee?: string;
  meta?: Record<string, unknown>;
}

const TICKET_PREFIX = "FRI";

export function nextTicketId(): string {
  const raw = getRawDb();
  // Use db_meta as a simple monotonic counter source.
  const get = raw
    .prepare("SELECT value FROM db_meta WHERE key = ?")
    .get("ticket_counter") as { value: string } | undefined;
  const next = (get ? parseInt(get.value, 10) : 0) + 1;
  raw
    .prepare(
      "INSERT INTO db_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run("ticket_counter", String(next));
  return `${TICKET_PREFIX}-${next}`;
}

export function createTicket(input: CreateTicketInput): Ticket {
  const db = getDb();
  const id = nextTicketId();
  const now = Date.now();
  const inserted = db
    .insert(schema.tickets)
    .values({
      id,
      title: input.title,
      body: input.body ?? null,
      status: input.status ?? "open",
      kind: input.kind ?? "task",
      assignee: input.assignee ?? null,
      metaJson: input.meta ? JSON.stringify(input.meta) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return rowToTicket(inserted);
}

export function getTicket(id: string): Ticket | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, id))
    .get();
  return row ? rowToTicket(row) : null;
}

export function listTickets(opts?: {
  status?: TicketStatus;
  assignee?: string;
}): Ticket[] {
  const db = getDb();
  const where = [];
  if (opts?.status) where.push(eq(schema.tickets.status, opts.status));
  if (opts?.assignee) where.push(eq(schema.tickets.assignee, opts.assignee));
  const base = db.select().from(schema.tickets);
  const filtered = where.length > 0 ? base.where(and(...where)) : base;
  return filtered
    .orderBy(desc(schema.tickets.updatedAt))
    .all()
    .map(rowToTicket);
}

export function updateTicket(
  id: string,
  patch: Partial<Omit<Ticket, "id" | "createdAt">>,
): Ticket | null {
  const db = getDb();
  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.body !== undefined) updates.body = patch.body;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.kind !== undefined) updates.kind = patch.kind;
  if (patch.assignee !== undefined) updates.assignee = patch.assignee;
  if (patch.meta !== undefined) {
    updates.metaJson = patch.meta ? JSON.stringify(patch.meta) : null;
  }
  db.update(schema.tickets).set(updates).where(eq(schema.tickets.id, id)).run();
  return getTicket(id);
}

export function addComment(
  ticketId: string,
  author: string,
  body: string,
): void {
  const db = getDb();
  db.insert(schema.ticketComments)
    .values({ ticketId, author, body, ts: Date.now() })
    .run();
  db.update(schema.tickets)
    .set({ updatedAt: Date.now() })
    .where(eq(schema.tickets.id, ticketId))
    .run();
}

export function listComments(ticketId: string): Array<{
  id: number;
  author: string;
  body: string;
  ts: number;
}> {
  const db = getDb();
  return db
    .select()
    .from(schema.ticketComments)
    .where(eq(schema.ticketComments.ticketId, ticketId))
    .all()
    .map((r) => ({
      id: r.id,
      author: r.author,
      body: r.body,
      ts: r.ts,
    }));
}

export function linkExternal(input: {
  ticketId: string;
  system: string;
  externalId: string;
  url?: string;
  meta?: Record<string, unknown>;
}): void {
  const db = getDb();
  db.insert(schema.ticketExternalLinks)
    .values({
      ticketId: input.ticketId,
      system: input.system,
      externalId: input.externalId,
      url: input.url ?? null,
      metaJson: input.meta ? JSON.stringify(input.meta) : null,
      linkedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

export interface TicketExternalLinkRow {
  ticketId: string;
  system: string;
  externalId: string;
  url: string | null;
  meta: Record<string, unknown> | null;
  linkedAt: number;
}

export function externalLinksBySystem(
  system: string,
): TicketExternalLinkRow[] {
  const db = getDb();
  return db
    .select()
    .from(schema.ticketExternalLinks)
    .where(eq(schema.ticketExternalLinks.system, system))
    .all()
    .map((r) => ({
      ticketId: r.ticketId,
      system: r.system,
      externalId: r.externalId,
      url: r.url,
      meta: r.metaJson
        ? (JSON.parse(r.metaJson) as Record<string, unknown>)
        : null,
      linkedAt: r.linkedAt,
    }));
}

export function externalLinks(ticketId: string): Array<{
  system: string;
  externalId: string;
  url: string | null;
  meta: Record<string, unknown> | null;
}> {
  const db = getDb();
  return db
    .select()
    .from(schema.ticketExternalLinks)
    .where(eq(schema.ticketExternalLinks.ticketId, ticketId))
    .all()
    .map((r) => ({
      system: r.system,
      externalId: r.externalId,
      url: r.url,
      meta: r.metaJson ? (JSON.parse(r.metaJson) as Record<string, unknown>) : null,
    }));
}

function rowToTicket(r: typeof schema.tickets.$inferSelect): Ticket {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    status: r.status as TicketStatus,
    kind: r.kind as TicketKind,
    assignee: r.assignee,
    meta: r.metaJson ? (JSON.parse(r.metaJson) as Record<string, unknown>) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
