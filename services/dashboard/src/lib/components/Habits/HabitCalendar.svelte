<script lang="ts">
  // FRI-169 — Habit detail calendar. Thin adapter over the reusable
  // HeatmapCalendar (the same grid the dashboard Activity card uses), so it
  // inherits month labels above the columns and per-cell date tooltips.
  //
  // Habit-specific cell semantics live in `resolve`:
  //   • Check-ins are placed on their real calendar dates; cell intensity
  //     (level 1..4) scales with that day's Check-in VOLUME, tinted in the
  //     habit's own hue (var(--habit-N) at graded alpha) rather than the
  //     global grid ramp.
  //   • A scheduled-but-missed day (a counted weekday in a day-Period habit,
  //     in the past, with no Check-in) is SLASHED.
  //   • Other empty days are level-0.

  import HeatmapCalendar from "$lib/components/Heatmap/HeatmapCalendar.svelte";
  import { isoDay, type HeatmapCellInfo } from "$lib/components/Heatmap/heatmap";
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

  // Tally Check-in volume per local day.
  const countByDay = $derived.by(() => {
    const m = new Map<string, number>();
    for (const c of checkins) {
      const key = isoDay(new Date(c.ts));
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  });

  const maxVolume = $derived(Math.max(1, ...Array.from(countByDay.values())));

  const todayStart = $derived(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()),
  );

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

  function fmtDate(iso: string): string {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  function resolve(iso: string, date: Date): HeatmapCellInfo {
    const count = countByDay.get(iso) ?? 0;
    if (count > 0) {
      const level = levelFor(count);
      return {
        className: "hm-habit filled",
        style: `--hc-color: var(--habit-${colorIndex}); --hc-alpha: ${0.25 + 0.25 * level};`,
        tooltip: `${count} check-in${count === 1 ? "" : "s"} on ${fmtDate(iso)}`,
      };
    }
    if (isScheduledDay(date) && date.getTime() < todayStart.getTime()) {
      return {
        className: "hm-habit slashed",
        tooltip: `Missed ${fmtDate(iso)}`,
      };
    }
    return { className: "hm-habit empty", tooltip: fmtDate(iso) };
  }
</script>

<HeatmapCalendar
  {resolve}
  {now}
  {weeks}
  cellSize={12}
  ariaLabel="Check-in calendar for {row.name}"
/>

<style>
  /* Cell fills — global so they reach the cells rendered inside
     HeatmapCalendar. Outlines use an inset box-shadow (the base .hm-cell
     resets the button border) so the square stays full-size. */
  :global(.hm-habit.empty) {
    background: var(--grid-empty);
    box-shadow: inset 0 0 0 1px var(--border-subtle);
  }

  /* Filled cells are the Habit colour at graded alpha — a per-habit heatmap
     rather than the global grid ramp. color-mix keeps the hue and dials
     opacity by heatmap level via --hc-alpha. */
  :global(.hm-habit.filled) {
    background: color-mix(
      in srgb,
      var(--hc-color) calc(var(--hc-alpha) * 100%),
      transparent
    );
  }

  :global(.hm-habit.slashed) {
    background: var(--grid-empty);
    box-shadow: inset 0 0 0 1px var(--border-subtle);
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
