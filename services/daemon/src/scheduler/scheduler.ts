import { eq } from "drizzle-orm";
import { getDb, isValidCron, nextRun, schema } from "@friday/shared";
import { logger } from "../log.js";
import { isAgentLive } from "../agent/lifecycle.js";
import * as registry from "../agent/registry.js";
import { spawnScheduledRun } from "./spawn.js";

/**
 * Thrown by `upsertSchedule` when the schedule name collides with an existing
 * registry agent of a different type (builder/helper/orchestrator/bare). The
 * API layer maps this to a 409.
 */
export class ScheduleNameCollisionError extends Error {
  constructor(name: string, existingType: string) {
    super(
      `cannot create schedule "${name}": an agent with that name already exists as type "${existingType}"`,
    );
    this.name = "ScheduleNameCollisionError";
  }
}

export interface ScheduleSpec {
  name: string;
  cron?: string;
  runAt?: string;
  taskPrompt: string;
  paused?: boolean;
}

export async function upsertSchedule(spec: ScheduleSpec): Promise<void> {
  if (spec.cron && !isValidCron(spec.cron)) {
    throw new Error(`invalid cron: ${spec.cron}`);
  }
  // FRI-76: eagerly register a stub agent so mail to this scheduled agent
  // passes recipient validation before the first cron fire. Reject if a
  // non-scheduled agent already owns the name — mail would be misrouted.
  const existingAgent = await registry.getAgent(spec.name);
  if (existingAgent && existingAgent.type !== "scheduled") {
    throw new ScheduleNameCollisionError(spec.name, existingAgent.type);
  }
  const db = getDb();
  const now = new Date();
  const next = computeNext(spec);
  const existingRows = await db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, spec.name))
    .limit(1);
  if (existingRows[0]) {
    await db
      .update(schema.schedules)
      .set({
        cron: spec.cron ?? null,
        runAt: spec.runAt ?? null,
        taskPrompt: spec.taskPrompt,
        paused: spec.paused ?? false,
        nextRunAt: next,
        updatedAt: now,
      })
      .where(eq(schema.schedules.name, spec.name));
  } else {
    await db.insert(schema.schedules).values({
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
    });
  }
  // Ensure the registry stub exists. Idempotent: if the agent has already
  // fired, this leaves the existing row's session/status untouched beyond
  // the standard registerAgent conflict-update (status=idle), which is the
  // correct state for a scheduled agent between fires.
  if (!existingAgent) {
    await registry.registerAgent({ name: spec.name, type: "scheduled" });
  }
}

export async function listSchedules(): Promise<unknown[]> {
  return await getDb().select().from(schema.schedules);
}

export async function getSchedule(
  name: string,
): Promise<typeof schema.schedules.$inferSelect | null> {
  const rows = await getDb()
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, name))
    .limit(1);
  return rows[0] ?? null;
}

export async function pauseSchedule(name: string): Promise<boolean> {
  const r = await getSchedule(name);
  if (!r) return false;
  await getDb()
    .update(schema.schedules)
    .set({ paused: true, updatedAt: new Date() })
    .where(eq(schema.schedules.name, name));
  return true;
}

export async function resumeSchedule(name: string): Promise<boolean> {
  const r = await getSchedule(name);
  if (!r) return false;
  // Recompute nextRunAt so a paused-during-due schedule doesn't immediately
  // fire on resume.
  const next = computeNext({
    name: r.name,
    cron: r.cron ?? undefined,
    runAt: r.runAt ?? undefined,
    taskPrompt: r.taskPrompt,
  });
  await getDb()
    .update(schema.schedules)
    .set({ paused: false, nextRunAt: next, updatedAt: new Date() })
    .where(eq(schema.schedules.name, name));
  return true;
}

export async function deleteSchedule(name: string): Promise<boolean> {
  const r = await getSchedule(name);
  if (!r) return false;
  const db = getDb();
  await db
    .delete(schema.schedules)
    .where(eq(schema.schedules.name, name));
  // FRI-76: if the registry stub was never used (no session, no blocks),
  // remove it too. Once the agent has fired, the row holds audit history
  // (sessionId, block rows) and is preserved.
  const agent = await registry.getAgent(name);
  if (agent && agent.type === "scheduled" && !agent.sessionId) {
    const blockCount = await db
      .select({ id: schema.blocks.id })
      .from(schema.blocks)
      .where(eq(schema.blocks.agentName, name))
      .limit(1);
    if (blockCount.length === 0) {
      await registry.deleteAgent(name);
    }
  }
  return true;
}

export function startScheduler(): NodeJS.Timeout {
  return setInterval(() => {
    void tick().catch((err: unknown) => {
      logger.log("warn", "scheduler.tick.error", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, 30_000);
}

async function tick(): Promise<void> {
  const db = getDb();
  const now = new Date();
  const all = await db.select().from(schema.schedules);
  // Phase 4.6: skip 'deleted' (tombstone — dashboard mutator
  // soft-deleted; row stays for cross-device convergence but the
  // schedule is logically gone) AND 'pending_register' /
  // 'reload_requested' (the LISTEN handler hasn't completed
  // the register/recompute yet; `nextRunAt` may be null or
  // stale). The 'active' and 'paused' statuses are the only ones
  // the tick should fire from.
  const due = all.filter(
    (r) =>
      !r.paused &&
      r.status !== "deleted" &&
      r.status !== "pending_register" &&
      r.status !== "reload_requested" &&
      r.nextRunAt !== null &&
      r.nextRunAt <= now,
  );
  for (const r of due) {
    if (isAgentLive(r.name)) {
      // FIX_FORWARD 4.4: previous fire still running. Don't leave
      // nextRunAt in the past (that would re-fire on every subsequent
      // tick); advance to the next cron-derived fire so the schedule
      // resumes its natural cadence once the current worker finishes.
      const nextAt = computeNext({
        name: r.name,
        cron: r.cron ?? undefined,
        runAt: r.runAt ?? undefined,
        taskPrompt: r.taskPrompt,
      });
      await db
        .update(schema.schedules)
        .set({ nextRunAt: nextAt })
        .where(eq(schema.schedules.name, r.name));
      logger.log("info", "schedule.skip-busy", {
        name: r.name,
        nextRunAt: nextAt?.toISOString() ?? null,
      });
      continue;
    }
    await fireSchedule(r);
  }
}

export async function fireSchedule(
  r: typeof schema.schedules.$inferSelect,
): Promise<string> {
  const runId = `r_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  logger.log("info", "schedule.fire", { name: r.name, runId });
  // Phase 5: `schedule_fired` SSE retired — Zero replicates the
  // `schedules` slice (and the `schedule_runs` history table) so
  // the dashboard sees the row's last_run_at / last_run_id update
  // through its reactive query.

  try {
    await spawnScheduledRun(r, runId);
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
  await db
    .update(schema.schedules)
    .set({ lastRunAt: new Date(), lastRunId: runId, nextRunAt: next })
    .where(eq(schema.schedules.name, r.name));
  return runId;
}

/**
 * Find a schedule and fire it now (out-of-band trigger). Returns the runId
 * for the spawned run, or null if the schedule doesn't exist or is already
 * running.
 */
export async function triggerSchedule(name: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, name))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  if (isAgentLive(r.name)) return null;
  return await fireSchedule(r);
}

function computeNext(spec: ScheduleSpec): Date | null {
  if (spec.cron) {
    return nextRun(spec.cron);
  }
  if (spec.runAt) {
    const t = Date.parse(spec.runAt);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  return null;
}

/**
 * First-turn prompt for the daily meta-agent. Drives the full evolve
 * pipeline: scan logs/usage/transcripts → enrich open proposals → cluster
 * near-duplicates → surface anything `critical` to the orchestrator via
 * mail. Maintains continuity across runs through `state.md`.
 */
const META_DAILY_PROMPT = [
  "You are the daily evolve meta-agent. Your job for this run:",
  "",
  "1. Call `evolve_scan({ windowHours: 24 })` to walk the daemon log + usage + transcripts and create or merge proposals from any new signals.",
  "2. Call `evolve_enrich({ limit: 20 })` to replace templated proposal bodies with Sonnet-generated root-cause analysis on the highest-priority unenriched items.",
  "3. Call `evolve_cluster({})` to group near-duplicate proposals.",
  "4. Call `evolve_list({ status: 'critical' })` and compare against the last run's `state.md` (auto-injected above).",
  "5. For any new `critical` proposals — or proposals that gained signals since yesterday — mail the orchestrator with a short summary (`mail_send({ to: 'friday', type: 'notification', body: ... })`). Include proposal ids so the orchestrator can `evolve_get` them.",
  "6. Update `state.md` with the run's proposal counts + critical ids you saw, so tomorrow knows what's new.",
  "7. Be quiet by default. Skip the mail if nothing actionable changed.",
  "",
  "Do NOT auto-apply or dismiss proposals — that is the orchestrator's call.",
].join("\n");

const META_WEEKLY_PROMPT = [
  "You are the weekly evolve meta-agent. Same shape as the daily run, but with a wider lens.",
  "",
  "1. Call `evolve_scan({ windowHours: 168 })` for a 7-day re-scan (catches signals that took a few days to recur).",
  "2. Call `evolve_enrich({ limit: 50 })` and `evolve_cluster({})`.",
  "3. Call `evolve_list({})` (all statuses) and read the bodies of anything not yet `applied` or `rejected`.",
  "4. From `state.md`, identify proposals that have been `open` for > 7 days without movement.",
  "5. Mail the orchestrator with a triage summary: counts by status, the stale-open list, and any `critical` items.",
  "6. Update `state.md` with the snapshot for next week.",
  "",
  "Do not auto-apply or dismiss; that's the orchestrator's call.",
].join("\n");

export async function seedMetaAgents(): Promise<void> {
  const db = getDb();
  const existing = await db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, "scheduled-meta-daily"))
    .limit(1);
  if (!existing[0]) {
    await upsertSchedule({
      name: "scheduled-meta-daily",
      cron: "0 4 * * *",
      taskPrompt: META_DAILY_PROMPT,
    });
  }
  const weekly = await db
    .select()
    .from(schema.schedules)
    .where(eq(schema.schedules.name, "scheduled-meta-weekly"))
    .limit(1);
  if (!weekly[0]) {
    await upsertSchedule({
      name: "scheduled-meta-weekly",
      cron: "0 5 * * 0",
      taskPrompt: META_WEEKLY_PROMPT,
    });
  }
}
