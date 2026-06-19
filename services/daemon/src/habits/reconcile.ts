/**
 * FRI-169 — Bounded-habit archival reconcile (daemon boundary).
 *
 * A Bounded Habit runs against a window (window_start..window_end). When that
 * window closes the Habit must archive as `completed` (window finished with the
 * Streak intact) or `expired` (window finished, Streak broken) — see
 * CONTEXT.md ### Habits → Habit mode, and the `habits.mode` comment in
 * db/schema.ts.
 *
 * The catch: a window closes on a CLOCK BOUNDARY, with NO write event — nothing
 * pokes the row at `window_end`. So a Bounded Habit left to itself would sit at
 * status='active' forever, never moving to the /habits archived/completed/
 * expired section. This module is the archival trigger — the habits analogue of
 * the scheduler tick (scheduler.ts:213 startScheduler): a periodic timer plus a
 * boot sweep that flips closed-window Bounded Habits to their terminal status.
 *
 * The completed-vs-expired verdict is NOT reinvented here. The pure streak
 * engine already derives it: computeStreak(spec, checkins, now).terminal is
 * `completed`|`expired` once now >= windowEnd (streak.ts:280-291 — completed if
 * the run at window-close was live, else expired). We REUSE that and merely
 * persist the result.
 *
 * Idempotent by construction: only status='active' rows are selected, so a
 * Habit that has already been flipped to a terminal status is never
 * re-processed (the second pass selects zero rows for it).
 */

import { and, eq, isNotNull, lte } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";
import { computeStreak } from "@friday/shared/habits";
import { logger } from "../log.js";
import { listCheckins } from "./store.js";
import { rowToSpec, rowsToCheckins } from "./streak.js";

/**
 * Flip every Bounded Habit whose window has closed (window_end <= now) and that
 * is still status='active' to its terminal status (`completed`|`expired`),
 * deriving the verdict from the pure streak engine. Returns the per-status
 * tally. Pass `now` for deterministic testing.
 */
export async function reconcileBoundedHabits(
  now = new Date(),
): Promise<{ completed: number; expired: number }> {
  const db = getDb();
  const due = await db
    .select()
    .from(schema.habits)
    .where(
      and(
        eq(schema.habits.status, "active"),
        eq(schema.habits.mode, "bounded"),
        isNotNull(schema.habits.windowEnd),
        lte(schema.habits.windowEnd, now),
      ),
    );

  let completed = 0;
  let expired = 0;
  for (const row of due) {
    const checkins = await listCheckins(row.id);
    const result = computeStreak(rowToSpec(row), rowsToCheckins(checkins), now);
    // `terminal` is guaranteed set here (now >= windowEnd was selected for in
    // SQL); the ?? is a defensive fallback so an unexpected null archives as
    // expired rather than silently no-op'ing.
    const newStatus = result.terminal ?? "expired";

    await db
      .update(schema.habits)
      .set({ status: newStatus, updatedAt: now })
      .where(eq(schema.habits.id, row.id));

    if (newStatus === "completed") completed++;
    else expired++;

    logger.log("info", "habits.bounded.reconcile", {
      id: row.id,
      status: newStatus,
      streak: result.count,
    });
  }

  return { completed, expired };
}

/**
 * The periodic archival timer. Bounded windows close on a clock boundary with
 * no write event, so a periodic sweep (paired with the boot sweep in index.ts)
 * is what actually archives them — the habits analogue of the scheduler tick
 * (scheduler.ts:214). Mirrors startScheduler's error-catch shape: the tick can
 * never throw out of the interval. Returns the timer handle so the caller can
 * clear it on shutdown.
 */
export function startHabitReconcile(): NodeJS.Timeout {
  return setInterval(() => {
    void reconcileBoundedHabits().catch((err: unknown) => {
      logger.log("warn", "habits.reconcile.error", { error: String(err) });
    });
  }, 60_000);
}
