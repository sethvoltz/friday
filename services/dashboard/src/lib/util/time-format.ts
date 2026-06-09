// Slack-canonical chat timestamps.
//
// All formatters take an explicit `now` so tests can pin a clock and the
// component layer can drive them off a shared per-minute tick store. The
// formatters are pure — no `Date.now()` reads inside.

const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function clockTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")} ${suffix}`;
}

function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole local-day delta between two timestamps. Positive when `a` is after `b`. */
function dayDelta(a: number, b: number): number {
  return Math.round((startOfLocalDay(a) - startOfLocalDay(b)) / 86_400_000);
}

/**
 * Slack-style relative time:
 *   - same local day → "2:14 PM"
 *   - yesterday      → "Yesterday at 2:14 PM"
 *   - delta in 2..6  → "Tuesday at 2:14 PM"
 *   - older same yr  → "Mar 15"
 *   - older          → "Mar 15, 2024"
 */
export function formatRelativeTime(ts: number, now: number): string {
  const d = new Date(ts);
  const delta = dayDelta(now, ts);
  if (delta <= 0) return clockTime(d);
  if (delta === 1) return `Yesterday at ${clockTime(d)}`;
  if (delta < 7) return `${WEEKDAY_LONG[d.getDay()]} at ${clockTime(d)}`;
  const nowYear = new Date(now).getFullYear();
  if (d.getFullYear() === nowYear) {
    return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
  }
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Day separator label:
 *   - today      → "Today"
 *   - yesterday  → "Yesterday"
 *   - same year  → "Saturday, May 17"
 *   - older      → "Saturday, May 17, 2024"
 */
export function formatDaySeparator(ts: number, now: number): string {
  const d = new Date(ts);
  const delta = dayDelta(now, ts);
  if (delta <= 0) return "Today";
  if (delta === 1) return "Yesterday";
  const nowYear = new Date(now).getFullYear();
  const base = `${WEEKDAY_LONG[d.getDay()]}, ${MONTH_LONG[d.getMonth()]} ${d.getDate()}`;
  if (d.getFullYear() === nowYear) return base;
  return `${base}, ${d.getFullYear()}`;
}

/**
 * Full absolute datetime for hover tooltips:
 *   "Sunday, May 17, 2026 at 2:14 PM"
 */
export function formatAbsoluteTooltip(ts: number): string {
  const d = new Date(ts);
  return `${WEEKDAY_LONG[d.getDay()]}, ${MONTH_LONG[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${clockTime(d)}`;
}

/**
 * Elapsed "M:SS" since a start instant, for the compaction-in-progress
 * readout. Returns null when there's no start instant (caller then renders the
 * label without a timer). Clamps negative deltas (clock skew) to "0:00" and
 * rejects non-finite inputs so a corrupt/garbage `compacting_since` can never
 * render "NaN:NaN" or an absurd string. Minutes are unbounded (a compaction
 * could legitimately run many minutes); seconds are zero-padded.
 */
export function formatCompactingElapsed(sinceMs: number | undefined, now: number): string | null {
  if (sinceMs == null || !Number.isFinite(sinceMs)) return null;
  const secs = Math.max(0, Math.floor((now - sinceMs) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Stable local-day key for grouping comparisons. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}
