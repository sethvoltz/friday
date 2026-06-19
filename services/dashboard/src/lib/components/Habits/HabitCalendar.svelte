<script lang="ts">
  // FRI-169 — Habit detail calendar. A full Sun→Sat week-column grid (the
  // ActivityGrid layout) showing one habit's Check-in history at full
  // granularity. Reuses the `ag-cell` square visual language:
  //
  //   • Check-ins are placed on their real calendar dates.
  //   • For a daily habit the grid reads as a HEATMAP — cell intensity
  //     (level-1..4) scales with that day's Check-in VOLUME.
  //   • A scheduled-but-missed day (a counted weekday in a day-Period habit,
  //     in the past, with no Check-in) is SLASHED.
  //   • Other empty days are level-0.
  //
  // The Habit color tints filled cells via var(--habit-N) at graded alpha,
  // so the heatmap stays in the habit's own hue rather than the global grid
  // ramp (which is for the daemon Activity card).

  import {
    type ZeroHabitRow,
    type ZeroHabitCheckinRow,
  } from "$lib/habits/adapt";

  interface Props {
    row: ZeroHabitRow;
    checkins: ZeroHabitCheckinRow[];
    now?: Date;
    /** How many weeks back to render (columns). */
    weeks?: number;
  }

  let { row, checkins, now = new Date(), weeks = 26 }: Props = $props();

  const colorIndex = $derived(
    row.color_index != null && row.color_index >= 1 && row.color_index <= 7
      ? row.color_index
      : 1,
  );

  const CELL = 12;
  const GAP = 3;
  const PITCH = CELL + GAP;
  const DAY_LABEL_W = 30;

  // Local-day ISO key (en-CA gives YYYY-MM-DD in local time).
  function isoDay(d: Date): string {
    return d.toLocaleDateString("en-CA");
  }

  // Tally Check-in volume per local day.
  const countByDay = $derived.by(() => {
    const m = new Map<string, number>();
    for (const c of checkins) {
      const key = isoDay(new Date(c.ts));
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  });

  const maxVolume = $derived(
    Math.max(1, ...Array.from(countByDay.values())),
  );

  const todayStart = $derived(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()),
  );

  interface DayCell {
    date: string;
    row: number; // 0=Sun..6=Sat
    /** 'empty' | 'slashed' | 'filled' */
    kind: "empty" | "slashed" | "filled";
    /** 1..4 heatmap level for filled cells; 0 otherwise. */
    level: number;
    count: number;
  }

  // Is this day a counted Period for a weekday-masked day-habit?
  function isScheduledDay(d: Date): boolean {
    if (row.period !== "day") return false;
    const mask = row.days_of_week ?? null;
    if (mask == null) return true; // every-day daily habit
    return (mask & (1 << d.getDay())) !== 0;
  }

  function levelFor(count: number): number {
    if (count <= 0) return 0;
    const ratio = count / maxVolume;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  const grid = $derived.by(() => {
    // End at this week's Saturday so the current week is the last column.
    const end = new Date(todayStart);
    const dow = end.getDay();
    end.setDate(end.getDate() + (dow === 0 ? 0 : 7 - dow));

    // Start `weeks` columns back, rolled to the preceding Sunday.
    const start = new Date(end);
    start.setDate(start.getDate() - (weeks * 7 - 1));
    const sdow = start.getDay();
    if (sdow !== 0) start.setDate(start.getDate() - sdow);

    const cols: DayCell[][] = [];
    let col: DayCell[] = [];
    const d = new Date(start);
    while (d <= end) {
      const isFuture = d > todayStart;
      if (!isFuture) {
        const key = isoDay(d);
        const count = countByDay.get(key) ?? 0;
        let kind: DayCell["kind"] = "empty";
        let level = 0;
        if (count > 0) {
          kind = "filled";
          level = levelFor(count);
        } else if (
          isScheduledDay(d) &&
          d.getTime() < todayStart.getTime()
        ) {
          // A past scheduled day with no Check-in — a miss.
          kind = "slashed";
        }
        col.push({ date: key, row: d.getDay(), kind, level, count });
      }
      if (d.getDay() === 6) {
        if (col.length) cols.push(col);
        col = [];
      }
      d.setDate(d.getDate() + 1);
    }
    if (col.length) cols.push(col);
    return cols;
  });

  const numWeeks = $derived(grid.length);
  const gridW = $derived(numWeeks * PITCH - GAP);
  const gridH = 7 * PITCH - GAP;

  const dayLabelRows = [
    { text: "Mon", row: 1 },
    { text: "Wed", row: 3 },
    { text: "Fri", row: 5 },
  ];

  function fmtDate(iso: string): string {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  function tip(c: DayCell): string {
    if (c.count > 0)
      return `${c.count} check-in${c.count === 1 ? "" : "s"} on ${fmtDate(c.date)}`;
    if (c.kind === "slashed") return `Missed ${fmtDate(c.date)}`;
    return fmtDate(c.date);
  }
</script>

<div class="hc-wrap">
  <svg
    width={DAY_LABEL_W + gridW}
    height={gridH}
    viewBox="0 0 {DAY_LABEL_W + gridW} {gridH}"
    class="hc-svg"
  >
    {#each dayLabelRows as dl}
      <text
        x={DAY_LABEL_W - 6}
        y={dl.row * PITCH + CELL * 0.8}
        text-anchor="end"
        class="hc-day"
      >{dl.text}</text>
    {/each}
  </svg>

  <div
    class="hc-cells"
    style="left: {DAY_LABEL_W}px; width: {gridW}px; height: {gridH}px"
  >
    {#each grid as week, wi}
      {#each week as cell}
        <span
          class="ag-cell hc-cell {cell.kind} level-{cell.level}"
          style="left: {wi * PITCH}px; top: {cell.row * PITCH}px; width: {CELL}px; height: {CELL}px; --hc-color: var(--habit-{colorIndex}); --hc-alpha: {0.25 + 0.25 * cell.level};"
          title={tip(cell)}
          aria-label={tip(cell)}
        ></span>
      {/each}
    {/each}
  </div>
</div>

<style>
  .hc-wrap {
    position: relative;
    overflow-x: auto;
  }

  .hc-svg {
    display: block;
  }

  .hc-day {
    font-size: 10px;
    fill: var(--text-tertiary);
    font-family: var(--font-sans);
  }

  .hc-cells {
    position: absolute;
    top: 0;
  }

  /* Reuse the ag-cell base geometry; override fills for habit semantics. */
  .hc-cell {
    position: absolute;
    border-radius: 2px;
    border: 1px solid transparent;
    box-sizing: border-box;
  }

  .hc-cell.empty {
    background: var(--grid-empty);
    border-color: var(--border-subtle);
  }

  /* Filled cells are the Habit color at graded alpha — a per-habit heatmap
     rather than the global grid ramp. color-mix keeps the hue and dials
     opacity by heatmap level via --hc-alpha. */
  .hc-cell.filled {
    background: color-mix(
      in srgb,
      var(--hc-color) calc(var(--hc-alpha) * 100%),
      transparent
    );
  }

  .hc-cell.slashed {
    background: var(--grid-empty);
    border-color: var(--border-subtle);
    background-image: linear-gradient(
      135deg,
      transparent 0%,
      transparent calc(50% - 1px),
      var(--text-tertiary) calc(50% - 1px),
      var(--text-tertiary) calc(50% + 1px),
      transparent calc(50% + 1px),
      transparent 100%
    );
  }
</style>
