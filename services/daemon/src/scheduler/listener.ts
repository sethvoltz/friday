/**
 * Phase 4.6 — schedules LISTEN handler + boot-recovery scan.
 *
 * The `createSchedule` / `updateSchedule` / `deleteSchedule` mutators
 * write Postgres state with a pending status; the Postgres trigger
 * (`friday_schedule_notify_trigger`, migration 0005) fires
 * `NOTIFY friday_schedule_changed` with `NEW.name` as payload. This
 * module owns the daemon-side side effects:
 *
 *   - `pending_register`: new schedule. Register the agent stub in
 *     the `agents` registry (so mail to the scheduled agent passes
 *     recipient validation before the first cron fire), compute
 *     nextRunAt from the cron expression, flip status='active'.
 *
 *   - `reload_requested`: cron/runAt/paused/taskPrompt may have
 *     changed. Recompute nextRunAt from the new spec, flip
 *     status='active'.
 *
 *   - `deleted`: dashboard soft-delete. Clean up the registry stub
 *     if it's unused (no session, no blocks). Row stays at
 *     'deleted' as a tombstone.
 *
 * Coexists with the legacy MCP/REST `upsertSchedule` path which
 * writes status='active' directly. The trigger predicate excludes
 * 'active' so the legacy path doesn't reenter this handler.
 *
 * Boot-recovery scan (plan §5): scan
 * `schedules WHERE status IN ('pending_register','reload_requested','deleted')`
 * at boot and apply the same handler. Catches changes that landed
 * while the daemon was down.
 */

import { and, eq, inArray } from "drizzle-orm";
import pgPkg from "pg";
import {
  getDb,
  getPool,
  nextRun,
  schema,
  LISTEN_CHANNELS,
} from "@friday/shared";
import * as registry from "../agent/registry.js";
import { logger } from "../log.js";

const { Client } = pgPkg;

function computeNext(
  row: typeof schema.schedules.$inferSelect,
): Date | null {
  if (row.cron) return nextRun(row.cron);
  if (row.runAt) {
    const t = Date.parse(row.runAt);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return null;
}

/**
 * Process a single pending schedule row. Idempotent on row state.
 */
async function processPendingScheduleRow(name: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, name))
    .limit(1);
  const row = rows[0];
  if (!row) return;

  if (row.status === "pending_register") {
    // Ensure the registry stub exists. The legacy
    // `upsertSchedule` flow registers eagerly so mail to the
    // scheduled agent is routable before the first fire — the
    // dashboard mutator must do the same.
    const existingAgent = await registry.getAgent(name);
    if (existingAgent && existingAgent.type !== "scheduled") {
      // Name collision with a non-scheduled agent — leave the row
      // at 'pending_register' so the boot-recovery scan retries
      // after the operator resolves the conflict. (No automatic
      // fix here; the dashboard form should pre-check.)
      logger.log("warn", "schedule.register.name-collision", {
        name,
        existingType: existingAgent.type,
      });
      return;
    }
    if (!existingAgent) {
      await registry.registerAgent({ name, type: "scheduled" });
    }
    const next = computeNext(row);
    await db
      .update(schema.schedules)
      .set({ status: "active", nextRunAt: next })
      .where(eq(schema.schedules.name, name));
    logger.log("info", "schedule.sync.registered", {
      name,
      nextRunAt: next?.toISOString() ?? null,
    });
    return;
  }

  if (row.status === "reload_requested") {
    const next = computeNext(row);
    await db
      .update(schema.schedules)
      .set({ status: "active", nextRunAt: next })
      .where(eq(schema.schedules.name, name));
    logger.log("info", "schedule.sync.reloaded", {
      name,
      nextRunAt: next?.toISOString() ?? null,
    });
    return;
  }

  if (row.status === "deleted") {
    // Tombstone — clean up the registry stub if it's unused.
    // Mirrors the legacy `deleteSchedule` semantic: once the
    // schedule has fired, the stub holds audit history (sessionId,
    // block rows) and is preserved.
    const agent = await registry.getAgent(name);
    if (agent && agent.type === "scheduled" && !agent.sessionId) {
      const blocks = await db
        .select({ id: schema.blocks.id })
        .from(schema.blocks)
        .where(eq(schema.blocks.agentName, name))
        .limit(1);
      if (blocks.length === 0) {
        await registry.deleteAgent(name);
      }
    }
    logger.log("info", "schedule.sync.deleted", { name });
    return;
  }

  // Other statuses (active, paused) — nothing for this handler.
}

/**
 * Boot-recovery scan: pick up any pending schedule rows missed
 * during daemon downtime. Same predicate as the LISTEN trigger so
 * the contract is symmetric.
 */
export async function runScheduleBootScan(): Promise<void> {
  try {
    const db = getDb();
    const rows = await db
      .select({ name: schema.schedules.name })
      .from(schema.schedules)
      .where(
        inArray(schema.schedules.status, [
          "pending_register",
          "reload_requested",
          "deleted",
        ]),
      );
    for (const row of rows) {
      await processPendingScheduleRow(row.name);
    }
    logger.log("info", "schedule.boot-scan.complete", { processed: rows.length });
  } catch (err) {
    logger.log("warn", "schedule.boot-scan.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  // Reference `and` to keep the import alive for future predicate
  // extensions (e.g., per-app scoping); without this Vitest would
  // warn about the unused import on first build.
  void and;
}

export interface ScheduleListenerHandle {
  stop: () => Promise<void>;
}

export async function startScheduleListener(): Promise<ScheduleListenerHandle> {
  const pool = getPool();
  const connectionString =
    (pool.options as { connectionString?: string }).connectionString ??
    process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL must be set to start the schedule LISTEN connection.",
    );
  }

  const client = new Client({ connectionString });
  await client.connect();

  client.on("notification", (msg) => {
    if (msg.channel !== LISTEN_CHANNELS.scheduleChanged) return;
    const name = msg.payload;
    if (!name) return;
    void processPendingScheduleRow(name).catch((err) => {
      logger.log("warn", "schedule.listen.process.error", {
        name,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  client.on("error", (err) => {
    logger.log("warn", "schedule.listen.client.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  await client.query(`LISTEN ${LISTEN_CHANNELS.scheduleChanged}`);
  logger.log("info", "schedule.listen.ready", {
    channel: LISTEN_CHANNELS.scheduleChanged,
  });

  return {
    stop: async (): Promise<void> => {
      try {
        await client.query(`UNLISTEN ${LISTEN_CHANNELS.scheduleChanged}`);
      } catch {
        // best-effort shutdown
      }
      await client.end().catch(() => {
        // ditto
      });
    },
  };
}
