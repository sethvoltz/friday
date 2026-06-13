/**
 * ADR-024 — `schedule_runs` history writes.
 *
 * The `schedule_runs` table records every fire of a schedule (one row per
 * fire), opened as `running` when the fire starts and transitioned to a
 * terminal `complete`/`error` when it finishes. Zero replicates the table
 * (it's in pg-provision's SYNC_TABLES and the sync schema), so the dashboard
 * can render a schedule's run history reactively.
 *
 * Lives in its own module so both the scheduler (which opens the row on fire
 * and closes it for the synchronous reminder path) and spawn.ts (which closes
 * the row from the agent-run worker's async onExit callback) can import it
 * without a circular dependency through scheduler.ts ⇄ spawn.ts.
 *
 * Recording is best-effort: a failed open/close is logged, never thrown, so a
 * history hiccup can never block or fail the actual schedule fire.
 */

import { eq } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";
import { logger } from "../log.js";

/**
 * Insert a `running` row in `schedule_runs` for a fire and return its
 * (bigserial) id so the caller can later transition it to a terminal status.
 * `schedule_runs` has no foreign key onto the daemon's runId string — the
 * row's bigserial id is the handle. Returns `null` (and logs) on failure.
 */
export async function openScheduleRun(scheduleName: string): Promise<number | null> {
  try {
    const db = getDb();
    const inserted = await db
      .insert(schema.scheduleRuns)
      .values({ scheduleName, firedAt: new Date(), status: "running" })
      .returning({ id: schema.scheduleRuns.id });
    return inserted[0]?.id ?? null;
  } catch (err) {
    logger.log("warn", "schedule.run-open.error", {
      name: scheduleName,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Transition a `schedule_runs` row to a terminal status (`complete`/`error`),
 * stamping `completedAt` and an optional error string. No-op when `id` is null
 * (the open insert failed). Best-effort: a failed close is logged, not thrown.
 */
export async function closeScheduleRun(
  id: number | null,
  status: "complete" | "error",
  error?: string,
): Promise<void> {
  if (id == null) return;
  try {
    const db = getDb();
    await db
      .update(schema.scheduleRuns)
      .set({ status, completedAt: new Date(), error: error ?? null })
      .where(eq(schema.scheduleRuns.id, id));
  } catch (err) {
    logger.log("warn", "schedule.run-close.error", {
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Boot-time orphan sweep. A `schedule_runs` row is opened `running` in memory:
 * the only handle to it is the in-memory `runRowId` threaded to the worker's
 * onExit. If the daemon crashes (or is killed) after `openScheduleRun` but
 * before the terminal close, that handle is lost and the row leaks `running`
 * forever — there is no live worker to ever close it. This sweep, run once at
 * daemon boot (alongside the other boot-recovery sweeps in index.ts), closes
 * every still-`running` row as `error: "daemon restart"`. Any worker that
 * actually survived a restart is impossible (the fork dies with the daemon),
 * so a `running` row at boot is always an orphan. Best-effort: a failed sweep
 * is logged, never thrown, so it can't block daemon startup.
 */
export async function sweepOrphanedScheduleRuns(): Promise<number> {
  try {
    const db = getDb();
    const closed = await db
      .update(schema.scheduleRuns)
      .set({ status: "error", completedAt: new Date(), error: "daemon restart" })
      .where(eq(schema.scheduleRuns.status, "running"))
      .returning({ id: schema.scheduleRuns.id });
    if (closed.length > 0) {
      logger.log("info", "schedule.run-sweep.orphans", { count: closed.length });
    }
    return closed.length;
  } catch (err) {
    logger.log("warn", "schedule.run-sweep.error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
