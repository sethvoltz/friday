// Pure geometry for the GitHub-contribution-style heatmap calendar shared by
// the dashboard Activity card and the habit detail calendar (HeatmapCalendar
// renders; this module decides the grid). Kept side-effect-free and clock-
// injected (`now` is always passed) so it unit-tests deterministically — the
// component layer only maps these cells to colors + tooltips.

/** A resolved cell's appearance + tooltip, returned by a caller's `resolve`. */
export interface HeatmapCellInfo {
  /** Caller-owned fill class(es) applied on top of the base `.hm-cell`. */
  className?: string;
  /** Extra inline style (e.g. per-habit colour vars). */
  style?: string;
  /** Hover tooltip text (also the cell's aria-label). */
  tooltip: string;
}

/** One rendered day square: its local-day ISO key and weekday row (Sun=0). */
export interface HeatmapCell {
  /** Local-day key, YYYY-MM-DD (en-CA in local time). */
  date: string;
  /** Weekday row, 0=Sun … 6=Sat. */
  row: number;
}

/** A month name positioned at the week column where that month first appears. */
export interface HeatmapMonthLabel {
  text: string;
  /** Week-column index this label sits above. */
  col: number;
}

export interface HeatmapGrid {
  /** Week columns, left→right oldest→newest; each column is Sun→Sat order. */
  columns: HeatmapCell[][];
  /** Month labels for the band above the grid. */
  monthLabels: HeatmapMonthLabel[];
  numWeeks: number;
}

const MONTH_NAMES = [
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

/** Local-day ISO key (en-CA yields YYYY-MM-DD in local time). */
export function isoDay(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

/** Local midnight of `d`. */
function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Build a `weeks`-column heatmap grid ending on the current week, excluding
 * future days. The grid always starts on a Sunday and the last column is the
 * current week (so "this week" is the rightmost column). Future days within
 * the current week are omitted, so the final column can be partial.
 */
export function buildHeatmapGrid(now: Date, weeks: number): HeatmapGrid {
  const todayStart = dayStart(now);

  // End on this week's Saturday so the current week is the last column.
  const end = new Date(todayStart);
  const dow = end.getDay();
  end.setDate(end.getDate() + (dow === 0 ? 0 : 7 - dow));

  // Start `weeks` columns back; the arithmetic lands on a Sunday already, but
  // roll back defensively in case of an off-cycle `weeks`.
  const start = new Date(end);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  const sdow = start.getDay();
  if (sdow !== 0) start.setDate(start.getDate() - sdow);

  const columns: HeatmapCell[][] = [];
  let col: HeatmapCell[] = [];
  const d = new Date(start);
  while (d <= end) {
    if (d <= todayStart) {
      col.push({ date: isoDay(d), row: d.getDay() });
    }
    if (d.getDay() === 6) {
      if (col.length) columns.push(col);
      col = [];
    }
    d.setDate(d.getDate() + 1);
  }
  if (col.length) columns.push(col);

  return {
    columns,
    monthLabels: monthLabelsFor(columns),
    numWeeks: columns.length,
  };
}

/**
 * Month labels positioned at the column where each month first appears,
 * nudged one column right when it would collide with the previous label
 * (matches the dashboard Activity card's original spacing rule).
 */
function monthLabelsFor(columns: HeatmapCell[][]): HeatmapMonthLabel[] {
  const labels: HeatmapMonthLabel[] = [];
  let lastMonth = -1;
  for (let wi = 0; wi < columns.length; wi++) {
    const first = columns[wi][0];
    if (!first) continue;
    const month = parseInt(first.date.slice(5, 7), 10) - 1;
    if (month !== lastMonth) {
      let col = wi;
      const prev = labels[labels.length - 1];
      if (prev && col - prev.col < 2) col = col + 1;
      // Never nudge a label off the right edge of the grid.
      col = Math.min(col, columns.length - 1);
      labels.push({ text: MONTH_NAMES[month], col });
      lastMonth = month;
    }
  }
  return labels;
}
