import { eq } from "drizzle-orm";
import { getDb, isValidCron, nextRun, schema } from "@friday/shared";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import { isAgentLive } from "../agent/lifecycle.js";
import { spawnScheduledRun } from "./spawn.js";

export interface ScheduleSpec {
  name: string;
  cron?: string;
  runAt?: string;
  taskPrompt: string;
  paused?: boolean;
}

export function upsertSchedule(spec: ScheduleSpec): void {
  if (spec.cron && !isValidCron(spec.cron)) {
    throw new Error(`invalid cron: ${spec.cron}`);
  }
  const db = getDb();
  const now = Date.now();
  const next = computeNext(spec);
  const existing = db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, spec.name))
    .get();
  if (existing) {
    db.update(schema.schedules)
      .set({
        cron: spec.cron ?? null,
        runAt: spec.runAt ?? null,
        taskPrompt: spec.taskPrompt,
        paused: spec.paused ?? false,
        nextRunAt: next,
        updatedAt: now,
      })
      .where(eq(schema.schedules.name, spec.name))
      .run();
  } else {
    db.insert(schema.schedules)
      .values({
        name: spec.name,
        cron: spec.cron ?? null,
        runAt: spec.runAt ?? null,
        taskPrompt: spec.taskPrompt,
        paused: spec.paused ?? false,
        nextRunAt: next,
        lastRunAt: null,
        lastRunId: null,
        metaJson: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

export function listSchedules(): unknown[] {
  return getDb().select().from(schema.schedules).all();
}

export function getSchedule(
  name: string,
): typeof schema.schedules.$inferSelect | null {
  const row = getDb()
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, name))
    .get();
  return row ?? null;
}

export function pauseSchedule(name: string): boolean {
  const r = getSchedule(name);
  if (!r) return false;
  getDb()
    .update(schema.schedules)
    .set({ paused: true, updatedAt: Date.now() })
    .where(eq(schema.schedules.name, name))
    .run();
  return true;
}

export function resumeSchedule(name: string): boolean {
  const r = getSchedule(name);
  if (!r) return false;
  // Recompute nextRunAt so a paused-during-due schedule doesn't immediately
  // fire on resume.
  const next = computeNext({
    name: r.name,
    cron: r.cron ?? undefined,
    runAt: r.runAt ?? undefined,
    taskPrompt: r.taskPrompt,
  });
  getDb()
    .update(schema.schedules)
    .set({ paused: false, nextRunAt: next, updatedAt: Date.now() })
    .where(eq(schema.schedules.name, name))
    .run();
  return true;
}

export function deleteSchedule(name: string): boolean {
  const r = getSchedule(name);
  if (!r) return false;
  getDb()
    .delete(schema.schedules)
    .where(eq(schema.schedules.name, name))
    .run();
  return true;
}

export function startScheduler(): NodeJS.Timeout {
  return setInterval(tick, 30_000);
}

function tick(): void {
  const db = getDb();
  const now = Date.now();
  const due = db
    .select()
    .from(schema.schedules)
    .all()
    .filter(
      (r) =>
        !r.paused &&
        r.nextRunAt !== null &&
        (r.nextRunAt as number) <= now,
    );
  for (const r of due) {
    if (isAgentLive(r.name)) {
      // Previous fire still running; skip this tick. nextRunAt stays so we
      // retry on the following tick once the worker exits.
      logger.log("info", "schedule.skip-busy", { name: r.name });
      continue;
    }
    fireSchedule(r);
  }
}

export function fireSchedule(
  r: typeof schema.schedules.$inferSelect,
): string {
  const runId = `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  logger.log("info", "schedule.fire", { name: r.name, runId });
  eventBus.publish({
    v: 1,
    type: "schedule_fired",
    schedule: r.name,
    run_id: runId,
  });

  try {
    spawnScheduledRun(r, runId);
  } catch (err) {
    logger.log("error", "schedule.spawn-error", {
      name: r.name,
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const next = computeNext({
    name: r.name,
    cron: r.cron ?? undefined,
    runAt: r.runAt ?? undefined,
    taskPrompt: r.taskPrompt,
  });
  const db = getDb();
  db.update(schema.schedules)
    .set({ lastRunAt: Date.now(), lastRunId: runId, nextRunAt: next })
    .where(eq(schema.schedules.name, r.name))
    .run();
  return runId;
}

/**
 * Find a schedule and fire it now (out-of-band trigger). Returns the runId
 * for the spawned run, or null if the schedule doesn't exist or is already
 * running.
 */
export function triggerSchedule(name: string): string | null {
  const db = getDb();
  const r = db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, name))
    .get();
  if (!r) return null;
  if (isAgentLive(r.name)) return null;
  return fireSchedule(r);
}

function computeNext(spec: ScheduleSpec): number | null {
  if (spec.cron) {
    const d = nextRun(spec.cron);
    return d ? d.getTime() : null;
  }
  if (spec.runAt) {
    const t = Date.parse(spec.runAt);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function seedMetaAgents(): void {
  const existing = getDb()
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, "scheduled-meta-daily"))
    .get();
  if (!existing) {
    upsertSchedule({
      name: "scheduled-meta-daily",
      cron: "0 4 * * *",
      taskPrompt: "Run friday evolve scan, then enrich, then list.",
    });
  }
  const weekly = getDb()
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, "scheduled-meta-weekly"))
    .get();
  if (!weekly) {
    upsertSchedule({
      name: "scheduled-meta-weekly",
      cron: "0 5 * * 0",
      taskPrompt:
        "Run friday evolve scan with --window=7d, enrich, re-cluster proposals.",
    });
  }
}
