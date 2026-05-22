import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export type TicketStatus = "open" | "in_progress" | "done" | "blocked" | "closed";
export type TicketKind = "task" | "epic" | "bug" | "chore";

export interface Ticket {
  id: string; // FRI-1234
  title: string;
  body: string | null;
  status: TicketStatus;
  kind: TicketKind;
  assignee: string | null;
  meta: Record<string, unknown> | null;
  /** Milliseconds since epoch. */
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

export async function nextTicketId(): Promise<string> {
  const db = getDb();
  // Use db_meta as a simple monotonic counter source. Postgres-side we
  // emulate the same upsert pattern via Drizzle.
  const rows = await db
    .select()
    .from(schema.dbMeta)
    .where(eq(schema.dbMeta.key, "ticket_counter"))
    .limit(1);
  const next = (rows[0] ? parseInt(rows[0].value, 10) : 0) + 1;
  await db
    .insert(schema.dbMeta)
    .values({ key: "ticket_counter", value: String(next) })
    .onConflictDoUpdate({
      target: schema.dbMeta.key,
      set: { value: String(next) },
    });
  return `${TICKET_PREFIX}-${next}`;
}

export async function createTicket(input: CreateTicketInput): Promise<Ticket> {
  const db = getDb();
  const id = await nextTicketId();
  const now = new Date();
  const insertedRows = await db
    .insert(schema.tickets)
    .values({
      id,
      title: input.title,
      body: input.body ?? null,
      status: input.status ?? "open",
      kind: input.kind ?? "task",
      assignee: input.assignee ?? null,
      metaJson: input.meta ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rowToTicket(insertedRows[0]);
}

export async function getTicket(id: string): Promise<Ticket | null> {
  const db = getDb();
  const rows = await db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1);
  return rows[0] ? rowToTicket(rows[0]) : null;
}

export async function listTickets(opts?: {
  status?: TicketStatus;
  assignee?: string;
}): Promise<Ticket[]> {
  const db = getDb();
  const where = [];
  if (opts?.status) where.push(eq(schema.tickets.status, opts.status));
  if (opts?.assignee) where.push(eq(schema.tickets.assignee, opts.assignee));
  const rows =
    where.length > 0
      ? await db
          .select()
          .from(schema.tickets)
          .where(and(...where))
          .orderBy(desc(schema.tickets.updatedAt))
      : await db.select().from(schema.tickets).orderBy(desc(schema.tickets.updatedAt));
  return rows.map(rowToTicket);
}

export async function updateTicket(
  id: string,
  patch: Partial<Omit<Ticket, "id" | "createdAt">>,
): Promise<Ticket | null> {
  const db = getDb();
  // Build a typed update payload. Date columns expect Date instances.
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.body !== undefined) updates.body = patch.body;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.kind !== undefined) updates.kind = patch.kind;
  if (patch.assignee !== undefined) updates.assignee = patch.assignee;
  if (patch.meta !== undefined) updates.metaJson = patch.meta ?? null;
  await db.update(schema.tickets).set(updates).where(eq(schema.tickets.id, id));
  return getTicket(id);
}

export async function addComment(ticketId: string, author: string, body: string): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.insert(schema.ticketComments).values({ ticketId, author, body, ts: now });
  await db.update(schema.tickets).set({ updatedAt: now }).where(eq(schema.tickets.id, ticketId));
}

export async function listComments(ticketId: string): Promise<
  Array<{
    /** UUID — Phase 4.4 flipped from bigserial to text. */
    id: string;
    author: string;
    body: string;
    /** Milliseconds since epoch. */
    ts: number;
  }>
> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.ticketComments)
    .where(eq(schema.ticketComments.ticketId, ticketId));
  return rows.map((r) => ({
    id: r.id,
    author: r.author,
    body: r.body,
    ts: r.ts.getTime(),
  }));
}

export async function linkExternal(input: {
  ticketId: string;
  system: string;
  externalId: string;
  url?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.ticketExternalLinks)
    .values({
      ticketId: input.ticketId,
      system: input.system,
      externalId: input.externalId,
      url: input.url ?? null,
      metaJson: input.meta ?? null,
      linkedAt: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * FIX_FORWARD 6.7: detach an external link from a ticket. Returns true if a
 * row was deleted, false otherwise. The (ticketId, system, externalId)
 * triple is the PK so the delete is unambiguous.
 */
export async function unlinkExternal(input: {
  ticketId: string;
  system: string;
  externalId: string;
}): Promise<boolean> {
  const db = getDb();
  const result = await db
    .delete(schema.ticketExternalLinks)
    .where(
      and(
        eq(schema.ticketExternalLinks.ticketId, input.ticketId),
        eq(schema.ticketExternalLinks.system, input.system),
        eq(schema.ticketExternalLinks.externalId, input.externalId),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

export interface TicketExternalLinkRow {
  ticketId: string;
  system: string;
  externalId: string;
  url: string | null;
  meta: Record<string, unknown> | null;
  /** Milliseconds since epoch. */
  linkedAt: number;
}

export async function externalLinksBySystem(system: string): Promise<TicketExternalLinkRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.ticketExternalLinks)
    .where(eq(schema.ticketExternalLinks.system, system));
  return rows.map((r) => ({
    ticketId: r.ticketId,
    system: r.system,
    externalId: r.externalId,
    url: r.url,
    meta: (r.metaJson as Record<string, unknown> | null) ?? null,
    linkedAt: r.linkedAt.getTime(),
  }));
}

export async function externalLinks(ticketId: string): Promise<
  Array<{
    system: string;
    externalId: string;
    url: string | null;
    meta: Record<string, unknown> | null;
  }>
> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.ticketExternalLinks)
    .where(eq(schema.ticketExternalLinks.ticketId, ticketId));
  return rows.map((r) => ({
    system: r.system,
    externalId: r.externalId,
    url: r.url,
    meta: (r.metaJson as Record<string, unknown> | null) ?? null,
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
    meta: (r.metaJson as Record<string, unknown> | null) ?? null,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

// Re-export sql for ad-hoc compositions by consumers.
export { sql };
