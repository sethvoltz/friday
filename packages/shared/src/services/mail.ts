import { and, asc, eq, isNull } from "drizzle-orm";
import { EventEmitter } from "node:events";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export type MailType = "message" | "notification" | "task";
export type MailDelivery = "pending" | "delivered" | "read" | "closed";

export interface SendMailInput {
  fromAgent: string;
  toAgent: string;
  type: MailType;
  body: string;
  meta?: Record<string, unknown>;
  /** Optional short subject — surfaces in inbox UX. */
  subject?: string;
  /** Optional thread id. Messages with the same id render grouped. */
  threadId?: string;
}

export interface MailRow {
  id: number;
  fromAgent: string;
  toAgent: string;
  type: MailType;
  delivery: MailDelivery;
  subject: string | null;
  threadId: string | null;
  body: string;
  meta: Record<string, unknown> | null;
  ts: number;
  readAt: number | null;
  closedAt: number | null;
}

/**
 * Singleton mail bus. The daemon imports this; mail_send fires `mail:delivered`
 * with the recipient agent name as the event name + a generic `mail:any` for
 * spectators (events server, dashboard).
 */
export const mailBus = new EventEmitter();

export function sendMail(input: SendMailInput): MailRow {
  const db = getDb();
  const ts = Date.now();
  const inserted = db
    .insert(schema.mail)
    .values({
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      type: input.type,
      delivery: "pending",
      subject: input.subject ?? null,
      threadId: input.threadId ?? null,
      body: input.body,
      metaJson: input.meta ? JSON.stringify(input.meta) : null,
      ts,
    })
    .returning()
    .get();
  const row = rowToMail(inserted);
  // Push delivery
  mailBus.emit(`mail:to:${input.toAgent}`, row);
  mailBus.emit("mail:any", row);
  return row;
}

export function inbox(toAgent: string): MailRow[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.mail)
    .where(
      and(
        eq(schema.mail.toAgent, toAgent),
        eq(schema.mail.delivery, "pending"),
      ),
    )
    .orderBy(asc(schema.mail.ts))
    .all();
  return rows.map(rowToMail);
}

export function markRead(id: number): void {
  const db = getDb();
  db.update(schema.mail)
    .set({ delivery: "read", readAt: Date.now() })
    .where(eq(schema.mail.id, id))
    .run();
}

export function markDelivered(id: number): void {
  const db = getDb();
  db.update(schema.mail)
    .set({ delivery: "delivered" })
    .where(eq(schema.mail.id, id))
    .run();
}

export function closeMail(id: number): void {
  const db = getDb();
  db.update(schema.mail)
    .set({ delivery: "closed", closedAt: Date.now() })
    .where(eq(schema.mail.id, id))
    .run();
}

export function getMail(id: number): MailRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(schema.mail)
    .where(eq(schema.mail.id, id))
    .get();
  return row ? rowToMail(row) : null;
}

export function pendingForAgent(toAgent: string): MailRow[] {
  return inbox(toAgent);
}

/**
 * Boot recovery: all rows still pending when the daemon last shut down need to
 * be re-emitted on the bus so workers waiting on mail get woken up.
 */
export function replayPending(): void {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.mail)
    .where(eq(schema.mail.delivery, "pending"))
    .all();
  for (const r of rows) {
    const row = rowToMail(r);
    mailBus.emit(`mail:to:${row.toAgent}`, row);
  }
}

function rowToMail(r: typeof schema.mail.$inferSelect): MailRow {
  return {
    id: r.id,
    fromAgent: r.fromAgent,
    toAgent: r.toAgent,
    type: r.type as MailType,
    delivery: r.delivery as MailDelivery,
    subject: r.subject,
    threadId: r.threadId,
    body: r.body,
    meta: r.metaJson ? (JSON.parse(r.metaJson) as Record<string, unknown>) : null,
    ts: r.ts,
    readAt: r.readAt,
    closedAt: r.closedAt,
  };
}
