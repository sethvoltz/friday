/**
 * FRI-169 — Habit data-access (daemon-side).
 *
 * The authoritative write/read surface for the `habits` + `habit_checkins`
 * tables. Mirrors the scheduler's DB-access style: `getDb()` + `schema.*` +
 * drizzle insert/update/select (see scheduler.ts:upsertSchedule). The daemon
 * is the sole writer the MCP `friday-habit` tools and the `/api/habits*` HTTP
 * routes go through.
 *
 * Invariants (CONTEXT.md ### Habits + ticket §1/§5):
 *   - Check-ins are APPEND-ONLY. `insertCheckin` only ever INSERTs; the single
 *     allowed mutation beyond INSERT is `deleteCheckin`'s one-row DELETE
 *     (the `habit_checkin_undo` write path).
 *   - `archiveHabit` sets status='archived' and NEVER deletes the habit row —
 *     Check-in history is preserved (Design Principle: preserve over delete).
 *   - The Streak is NOT stored here. It is derived on read by withStreak()
 *     (see ./streak.ts) from the Check-in log against the current clock.
 *
 * `id`/`created_at` are supplied by the Postgres column defaults
 * (gen_random_uuid()::text / now()) when omitted, so an MCP/HTTP create need
 * not synthesize them — `.returning()` reads the assigned row back.
 */

import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";

export type HabitRow = typeof schema.habits.$inferSelect;
export type HabitCheckinRow = typeof schema.habitCheckins.$inferSelect;

/** The mutable subset a create accepts (id/timestamps are server-supplied). */
export interface CreateHabitInput {
  name: string;
  mode: string;
  period: string;
  target?: number;
  description?: string | null;
  daysOfWeek?: number | null;
  bucket?: string | null;
  colorIndex?: number | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
}

/** The patchable subset of a habit definition. All optional. */
export interface UpdateHabitInput {
  name?: string;
  description?: string | null;
  mode?: string;
  period?: string;
  target?: number;
  daysOfWeek?: number | null;
  bucket?: string | null;
  colorIndex?: number | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  status?: string;
}

export interface InsertCheckinInput {
  /** Completion time. Defaults to now() when omitted (supports backdating). */
  ts?: Date;
  note?: string | null;
}

export type HabitFilter = "active" | "archived";

/**
 * Create a habit. `id` defaults to gen_random_uuid()::text and
 * created_at/updated_at are stamped here so the row reads back fully
 * populated. Returns the inserted row.
 */
export async function createHabit(input: CreateHabitInput): Promise<HabitRow> {
  const now = new Date();
  const rows = await getDb()
    .insert(schema.habits)
    .values({
      name: input.name,
      description: input.description ?? null,
      mode: input.mode,
      target: input.target ?? 1,
      period: input.period,
      daysOfWeek: input.daysOfWeek ?? null,
      bucket: input.bucket ?? null,
      colorIndex: input.colorIndex ?? null,
      windowStart: input.windowStart ?? null,
      windowEnd: input.windowEnd ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rows[0]!;
}

/**
 * List habits filtered by status family. `active` returns status='active';
 * `archived` returns the terminal trio (archived|completed|expired) — every
 * non-active habit the UI lists below the fold. Ordered newest-first.
 */
export async function listHabits(filter: HabitFilter = "active"): Promise<HabitRow[]> {
  const db = getDb();
  const rows = await db.select().from(schema.habits);
  const isActive = (r: HabitRow): boolean => r.status === "active";
  const filtered = rows.filter((r) => (filter === "active" ? isActive(r) : !isActive(r)));
  // Newest-first by updatedAt.
  filtered.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return filtered;
}

export async function getHabit(id: string): Promise<HabitRow | null> {
  const rows = await getDb().select().from(schema.habits).where(eq(schema.habits.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Patch a habit definition. Only provided fields are written; updatedAt is
 * always bumped. Returns the updated row, or null if the id doesn't exist.
 */
export async function updateHabit(id: string, patch: UpdateHabitInput): Promise<HabitRow | null> {
  const set: Partial<typeof schema.habits.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.mode !== undefined) set.mode = patch.mode;
  if (patch.period !== undefined) set.period = patch.period;
  if (patch.target !== undefined) set.target = patch.target;
  if (patch.daysOfWeek !== undefined) set.daysOfWeek = patch.daysOfWeek;
  if (patch.bucket !== undefined) set.bucket = patch.bucket;
  if (patch.colorIndex !== undefined) set.colorIndex = patch.colorIndex;
  if (patch.windowStart !== undefined) set.windowStart = patch.windowStart;
  if (patch.windowEnd !== undefined) set.windowEnd = patch.windowEnd;
  if (patch.status !== undefined) set.status = patch.status;

  const rows = await getDb()
    .update(schema.habits)
    .set(set)
    .where(eq(schema.habits.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Archive a habit: status='archived', bump updatedAt. PRESERVE over delete —
 * the habit row and its Check-in history stay. Returns the row, or null if
 * the id doesn't exist.
 */
export async function archiveHabit(id: string): Promise<HabitRow | null> {
  const rows = await getDb()
    .update(schema.habits)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(schema.habits.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Append a Check-in. INSERT-only (append-only log). `id` defaults to a uuid
 * and created_at to now(); `ts` (the completion time, which backdating moves)
 * defaults to now() when omitted. Returns the inserted Check-in.
 */
export async function insertCheckin(
  habitId: string,
  input: InsertCheckinInput = {},
): Promise<HabitCheckinRow> {
  const rows = await getDb()
    .insert(schema.habitCheckins)
    .values({
      habitId,
      ts: input.ts ?? new Date(),
      note: input.note ?? null,
    })
    .returning();
  return rows[0]!;
}

/**
 * Delete exactly one Check-in by its id (the `habit_checkin_undo` write path —
 * the single allowed DELETE in this module). Sibling Check-ins for the same
 * habit are untouched. Returns true if a row was removed.
 */
export async function deleteCheckin(checkinId: string): Promise<boolean> {
  const rows = await getDb()
    .delete(schema.habitCheckins)
    .where(eq(schema.habitCheckins.id, checkinId))
    .returning({ id: schema.habitCheckins.id });
  return rows.length > 0;
}

/**
 * All Check-ins for a habit, oldest-first. The streak engine's input; ordering
 * is not required by computeStreak (it scans), but ascending ts keeps the
 * recent-check-ins view (habit_status) deterministic.
 */
export async function listCheckins(habitId: string): Promise<HabitCheckinRow[]> {
  return await getDb()
    .select()
    .from(schema.habitCheckins)
    .where(eq(schema.habitCheckins.habitId, habitId))
    .orderBy(asc(schema.habitCheckins.ts));
}
