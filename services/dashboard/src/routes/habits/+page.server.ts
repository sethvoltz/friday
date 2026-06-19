import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";
import type { ZeroHabitRow } from "$lib/habits/adapt";

/**
 * FRI-169 — /habits SSR initial load.
 *
 * Mirrors schedules/+page.server.ts: SSR the initial list via
 * `daemonGet("/api/habits")` so the first paint has data even before Zero
 * hydrates, then the page swaps to the live `zeroSync.habits` binding once the
 * client store is up (same dual pattern as /schedules).
 *
 * The daemon route returns camelCase, streak-decorated rows with ISO-string
 * timestamps (Drizzle `Date` columns serialized over JSON). The dashboard's
 * habit COMPONENTS consume the snake_case, epoch-millis `ZeroHabitRow` shape
 * (so a single `$lib/habits/adapt` projection serves BOTH the SSR fallback and
 * the live Zero rows). We normalise the daemon shape into `ZeroHabitRow` here,
 * once, at the load boundary — never at a component.
 */

/** The streak-decorated habit shape the daemon's GET /api/habits returns. */
interface DaemonHabitRow {
  id: string;
  name: string;
  description: string | null;
  mode: string;
  target: number;
  period: string;
  daysOfWeek: number | null;
  bucket: string | null;
  colorIndex: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** ms-epoch from an ISO timestamp string (or null). */
function ms(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Project the daemon's camelCase/ISO row onto the snake_case/epoch-millis
 * `ZeroHabitRow` the components expect — the SSR mirror of what Zero replicates
 * to `zeroSync.habits`.
 */
function toZeroHabitRow(h: DaemonHabitRow): ZeroHabitRow {
  return {
    id: h.id,
    name: h.name,
    description: h.description,
    mode: h.mode as ZeroHabitRow["mode"],
    target: h.target,
    period: h.period as ZeroHabitRow["period"],
    days_of_week: h.daysOfWeek,
    bucket: h.bucket as ZeroHabitRow["bucket"],
    color_index: h.colorIndex,
    window_start: ms(h.windowStart),
    window_end: ms(h.windowEnd),
    status: h.status as ZeroHabitRow["status"],
    created_at: ms(h.createdAt) ?? 0,
    updated_at: ms(h.updatedAt) ?? 0,
  };
}

export const load: PageServerLoad = async () => {
  // Active habits up top; the terminal (archived/completed/expired) set is
  // fetched too so the de-emphasized "below the fold" list has SSR data. The
  // live Zero binding is unfiltered and supersedes both once it hydrates.
  try {
    const [active, archived] = await Promise.all([
      daemonGet<DaemonHabitRow[]>("/api/habits?filter=active"),
      daemonGet<DaemonHabitRow[]>("/api/habits?filter=archived"),
    ]);
    return {
      habits: [...active, ...archived].map(toZeroHabitRow),
    };
  } catch {
    return { habits: [] as ZeroHabitRow[] };
  }
};
