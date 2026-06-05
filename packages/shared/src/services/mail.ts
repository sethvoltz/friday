import { and, asc, eq, gt } from "drizzle-orm";
import { EventEmitter } from "node:events";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";

export type MailType = "message" | "notification" | "task";
/**
 * FRI-116: the legacy 4-value union (pending/delivered/read/closed)
 * narrowed to three. Production data only ever lands at `pending`
 * (insert), `read` (worker drained the inbox), or `closed` (terminal
 * after a reply or explicit close). The DB check constraint at
 * `schema.ts:241` still accepts the legacy 4-value set (no migration
 * per the strategy-1 default in FRI-116); the TS union narrows the
 * codebase-side write surface, and the unused writer helper was
 * deleted.
 */
export type MailDelivery = "pending" | "read" | "closed";
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
    .where(and(eq(schema.mail.toAgent, toAgent), eq(schema.mail.delivery, "pending")))
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

export async function closeMail(id: number): Promise<void> {
  const db = getDb();
  await db
    .update(schema.mail)
    .set({ delivery: "closed", closedAt: new Date() })
    .where(eq(schema.mail.id, id));
}

export async function getMail(id: number): Promise<MailRow | null> {
  const db = getDb();
  const rows = await db.select().from(schema.mail).where(eq(schema.mail.id, id)).limit(1);
  return rows[0] ? rowToMail(rows[0]) : null;
}

/**
 * FRI-154: shape of the persisted dead-letter sentinel. Lives under
 * `mail.meta_json.dead_letter`. The respawn-on-force-kill path reads this to
 * exclude rows that already dead-lettered from its unprocessed count, so a
 * deterministic-crash agent doesn't loop forever just because the daemon
 * restarted between dead-letter and the next event.
 */
export interface MailDeadLetterSentinel {
  /** The agent name whose respawn streak tripped the gate. */
  agent: string;
  /** Wall-clock when dead-letter fired. */
  at: number;
  /** Streak length when the gate tripped. */
  attempts: number;
}

/**
 * Stamp `meta_json.dead_letter` onto a mail row without disturbing any
 * other meta keys. Preserve-over-delete: the row stays at `delivery='pending'`
 * so the operator can still see/triage/close it; only the auto-respawn path
 * filters on this sentinel.
 */
export async function markMailDeadLetter(
  id: number,
  sentinel: MailDeadLetterSentinel,
): Promise<void> {
  const db = getDb();
  const cur = await db
    .select({ metaJson: schema.mail.metaJson })
    .from(schema.mail)
    .where(eq(schema.mail.id, id))
    .limit(1);
  const prev = (cur[0]?.metaJson as Record<string, unknown> | null) ?? {};
  const next = { ...prev, dead_letter: sentinel };
  await db.update(schema.mail).set({ metaJson: next }).where(eq(schema.mail.id, id));
}

/**
 * True when a {@link MailRow} carries the dead-letter sentinel. Used by the
 * respawn path to filter the inbox view.
 */
export function isMailDeadLettered(row: MailRow): boolean {
  return row.meta != null && typeof row.meta === "object" && "dead_letter" in row.meta;
}

export async function pendingForAgent(toAgent: string): Promise<MailRow[]> {
  return inbox(toAgent);
}

/**
 * FRI-118: replayPending caps re-emission at 7 days. Older pending rows
 * remain in the DB (surfaced via `pendingForAgent` / `inbox` for human
 * triage) but are NOT re-dispatched on the mail bus. The boot-storm of
 * a multi-month accumulation — observed pre-2026-05-22 as 9 rows that
 * survived ~10 daemon restarts because nothing aged them out — is what
 * this guard closes. Paired with `mail-prune` (services/mail-prune.ts)
 * which hard-deletes pending rows older than 30 days whose recipient
 * is archived or missing.
 */
export const REPLAY_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Boot recovery: re-emit every `delivery='pending'` row from the last
 * REPLAY_PENDING_MAX_AGE_MS so workers waiting on mail get woken up.
 */
export async function replayPending(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - REPLAY_PENDING_MAX_AGE_MS);
  const rows = await db
    .select()
    .from(schema.mail)
    .where(and(eq(schema.mail.delivery, "pending"), gt(schema.mail.ts, cutoff)));
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
