/**
 * FRI-118: weekly prune of stale-recipient pending mail.
 *
 * `replayPending()` (packages/shared/src/services/mail.ts) caps boot-time
 * re-emission to <7 days, so any row older than that never wakes a worker.
 * But the row stays in the DB indefinitely — which would build up forever
 * if nobody ever drained it. This pruner deletes the cases that can never
 * deliver:
 *
 *  - `delivery='pending'`, AND
 *  - older than 30 days, AND
 *  - recipient is `agents.status='archived'` OR has no row in `agents`.
 *
 * 30 days is intentional: one bug-hunt cycle of dropped mail can't
 * snowball into a "never delivered" boot-storm, but the operator still
 * has a buffer to recover misrouted notifications manually.
 *
 * Pattern mirrors `services/daemon/src/agent/invariants.ts`:
 * `setInterval(...).unref()` + one immediate run on boot + a `stop*`
 * for clean shutdown.
 */

import { and, eq, exists, lt, not, or } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";
import { logger } from "../log.js";

const PRUNE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000; //     30 days

let interval: NodeJS.Timeout | undefined;

/**
 * Start the mail pruner. Idempotent — calling twice is a no-op.
 */
export function startMailPruner(): NodeJS.Timeout | undefined {
  if (interval) return interval;
  interval = setInterval(() => {
    void prune().catch((err: unknown) => {
      logger.log("warn", "mail.prune.error", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, PRUNE_INTERVAL_MS);
  interval.unref();
  // Run once immediately so a fresh-boot accumulation gets caught before
  // the 7d timer first fires.
  void prune().catch((err: unknown) => {
    logger.log("warn", "mail.prune.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return interval;
}

export function stopMailPruner(): void {
  if (interval) {
    clearInterval(interval);
    interval = undefined;
  }
}

/**
 * One prune pass. Exported for testability — tests drive `prune()`
 * directly instead of waiting on the timer.
 *
 * Where clause:
 *   delivery = 'pending'
 *   AND ts < now() - 30 days
 *   AND (
 *     EXISTS (SELECT 1 FROM agents WHERE name = mail.to_agent AND status='archived')
 *     OR
 *     NOT EXISTS (SELECT 1 FROM agents WHERE name = mail.to_agent)
 *   )
 */
export async function prune(): Promise<{ deleted: number }> {
  const db = getDb();
  const cutoff = new Date(Date.now() - PRUNE_AGE_MS);

  const archivedRecipient = db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.name, schema.mail.toAgent), eq(schema.agents.status, "archived")));
  const anyRecipient = db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.name, schema.mail.toAgent));

  const result = await db
    .delete(schema.mail)
    .where(
      and(
        eq(schema.mail.delivery, "pending"),
        lt(schema.mail.ts, cutoff),
        or(exists(archivedRecipient), not(exists(anyRecipient))),
      ),
    );

  const deleted = result.rowCount ?? 0;
  if (deleted > 0) {
    logger.log("info", "mail.prune.summary", { deleted });
  }
  return { deleted };
}
