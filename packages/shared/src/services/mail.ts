import { and, asc, eq } from "drizzle-orm";
import { EventEmitter } from "node:events";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export type MailType = "message" | "notification" | "task";
export type MailDelivery = "pending" | "delivered" | "read" | "closed";
/**
 * `normal` mail drains at the next turn boundary (between full turns, as
 * today). `critical` mail drains at the next SDK iteration boundary —
 * mid-turn injection (FIX_FORWARD 2.3/2.4). Used sparingly by helpers and
 * builders for sub-agent-return-style replies to a parent that's mid-turn.
 */
export type MailPriority = "normal" | "critical";

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
  /** Defaults to 'normal'. See MailPriority docs. */
  priority?: MailPriority;
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
  /** Milliseconds since epoch. */
  ts: number;
  readAt: number | null;
  closedAt: number | null;
  priority: MailPriority;
}

/**
 * Singleton mail bus. The daemon imports this; mail_send fires `mail:delivered`
 * with the recipient agent name as the event name + a generic `mail:any` for
 * spectators (events server, dashboard).
 */
export const mailBus = new EventEmitter();

export async function sendMail(input: SendMailInput): Promise<MailRow> {
  const db = getDb();
  const priority: MailPriority = input.priority ?? "normal";
  const insertedRows = await db
    .insert(schema.mail)
    .values({
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      type: input.type,
      delivery: "pending",
      subject: input.subject ?? null,
      threadId: input.threadId ?? null,
      body: input.body,
      metaJson: input.meta ?? null,
      ts: new Date(),
      priority,
    })
    .returning();
  const row = rowToMail(insertedRows[0]);
  // Push delivery. The mail-bridge subscribes to `mail:any`; the worker may
  // subscribe to its own `mail:to:<recipient>` channel. Critical mail emits
  // an extra `mail:critical:<recipient>` so 2.4's mid-turn-injection check
  // has a dedicated signal without inspecting the full inbox.
  mailBus.emit(`mail:to:${input.toAgent}`, row);
  if (priority === "critical") {
    mailBus.emit(`mail:critical:${input.toAgent}`, row);
  }
  mailBus.emit("mail:any", row);
  return row;
}

export async function inbox(toAgent: string): Promise<MailRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.mail)
    .where(
      and(
        eq(schema.mail.toAgent, toAgent),
        eq(schema.mail.delivery, "pending"),
      ),
    )
    .orderBy(asc(schema.mail.ts));
  return rows.map(rowToMail);
}

export async function markRead(id: number): Promise<void> {
  const db = getDb();
  await db
    .update(schema.mail)
    .set({ delivery: "read", readAt: new Date() })
    .where(eq(schema.mail.id, id));
}

export async function markDelivered(id: number): Promise<void> {
  const db = getDb();
  await db
    .update(schema.mail)
    .set({ delivery: "delivered" })
    .where(eq(schema.mail.id, id));
}

export async function closeMail(id: number): Promise<void> {
  const db = getDb();
  await db
    .update(schema.mail)
    .set({ delivery: "closed", closedAt: new Date() })
    .where(eq(schema.mail.id, id));
}

export async function getMail(id: number): Promise<MailRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.mail)
    .where(eq(schema.mail.id, id))
    .limit(1);
  return rows[0] ? rowToMail(rows[0]) : null;
}

export async function pendingForAgent(toAgent: string): Promise<MailRow[]> {
  return inbox(toAgent);
}

/**
 * Boot recovery: all rows still pending when the daemon last shut down need to
 * be re-emitted on the bus so workers waiting on mail get woken up.
 */
export async function replayPending(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.mail)
    .where(eq(schema.mail.delivery, "pending"));
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
    meta: (r.metaJson as Record<string, unknown> | null) ?? null,
    ts: r.ts.getTime(),
    readAt: r.readAt ? r.readAt.getTime() : null,
    closedAt: r.closedAt ? r.closedAt.getTime() : null,
    priority: (r.priority as MailPriority) ?? "normal",
  };
}
