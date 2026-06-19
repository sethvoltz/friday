<script lang="ts">
  // FRI-169 — one habit's summary row:
  //
  //   [N <unit> streak]   |   [ filled filled slashed empty ]   (+k)
  //
  // The numeric Streak is the headline; PRIOR Periods collapse into the
  // number, never into squares (CONTEXT.md ### Habits → Streak). The square
  // strip shows only the live frontier, by family:
  //
  //   • PER-DAY habit (period='day'): a rolling window of the last ~7 day-
  //     Slot squares — filled / slashed (past counted day, missed) / empty
  //     (today, still open). Weekday-masked habits show only counted days.
  //
  //   • FLOATING-QUOTA habit (target>1 over week/month/year): the CURRENT
  //     Period's quota Slots filling in order (resolveSlots). When target
  //     exceeds the square cap (~12) the strip is replaced by a compact
  //     proportional "f/target" indicator so a 20-quota habit doesn't
  //     render 20 squares.
  //
  // Dormant streaks show a muted em-dash, never "0 streak".

  import HabitSquare from "./HabitSquare.svelte";
  import {
    habitStreak,
    habitSlots,
    streakUnitLabel,
    type ZeroHabitRow,
    type ZeroHabitCheckinRow,
  } from "$lib/habits/adapt";
  import type { SlotState } from "@friday/shared/habits";

  interface Props {
    /** The snake_case Zero habit row. */
    row: ZeroHabitRow;
    /** This habit's Check-in rows (epoch-millis ts). */
    checkins: ZeroHabitCheckinRow[];
    /** Injectable clock for deterministic rendering/tests. */
    now?: Date;
    /** Per-day rolling window length (number of day-Slots shown). */
    perDayWindow?: number;
    /** Floating-quota square cap; above this, switch to "f/target". */
    squareCap?: number;
  }

  let {
    row,
    checkins,
    now = new Date(),
    perDayWindow = 7,
    squareCap = 12,
  }: Props = $props();

  const colorIndex = $derived(row.color_index ?? 1);

  // --- Headline streak --------------------------------------------------
  const streak = $derived(habitStreak(row, checkins, now));
  const isDormant = $derived(streak.state === "dormant");
  const unit = $derived(streakUnitLabel(row.period));

  // --- Slot strip -------------------------------------------------------
  const isPerDay = $derived(row.period === "day");

  // A floating quota above the cap renders a proportional indicator instead
  // of an over-long square strip.
  const useProportional = $derived(!isPerDay && row.target > squareCap);

  interface StripSquare {
    state: SlotState;
    label: string;
  }

  /**
   * PER-DAY strip: walk the last `perDayWindow` calendar days ending today,
   * skipping non-counted weekdays for masked habits, and resolve each day's
   * single Slot. The current day stays open (empty until filled); past days
   * slash if missed.
   */
  function perDaySquares(): StripSquare[] {
    const mask = row.days_of_week ?? null;
    const out: StripSquare[] = [];
    const cursor = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    // Walk back day by day collecting counted days until we have a window's
    // worth (bounded hard at 31 hops so a sparse mask can't loop forever).
    let hops = 0;
    while (out.length < perDayWindow && hops < 31) {
      const counted = mask == null || (mask & (1 << cursor.getDay())) !== 0;
      if (counted) {
        const res = habitSlots(row, checkins, new Date(cursor), now);
        out.push({
          state: res.slots[0] ?? "empty",
          label: `${dayLabel(cursor)} — ${slotWord(res.slots[0] ?? "empty")}`,
        });
      }
      cursor.setDate(cursor.getDate() - 1);
      hops++;
    }
    // Collected newest-first; reverse to read left→right oldest→newest.
    return out.reverse();
  }

  /**
   * FLOATING strip: the current Period's quota Slots, filling in order.
   */
  function floatingSquares(): StripSquare[] {
    const res = habitSlots(row, checkins, now, now);
    return res.slots.map((state, i) => ({
      state,
      label: `Slot ${i + 1} of ${row.target} — ${slotWord(state)}`,
    }));
  }

  const squares = $derived.by<StripSquare[]>(() => {
    if (useProportional) return [];
    return isPerDay ? perDaySquares() : floatingSquares();
  });

  // Overflow (+k) — Check-ins past Target in the current Period (volume).
  const overflow = $derived(
    useProportional || isPerDay ? 0 : habitSlots(row, checkins, now, now).overflow,
  );

  // Proportional indicator value: filled / target for the current Period.
  const proportional = $derived.by(() => {
    if (!useProportional) return null;
    const res = habitStreak(row, checkins, now);
    return { filled: res.currentPeriodProgress.filled, target: row.target };
  });

  function slotWord(s: SlotState): string {
    return s === "filled" ? "done" : s === "slashed" ? "missed" : "open";
  }
  function dayLabel(d: Date): string {
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
</script>

<div class="habit-summary">
  <div class="habit-head">
    <span
      class="habit-dot"
      style="background: var(--habit-{colorIndex >= 1 && colorIndex <= 7 ? colorIndex : 1});"
      aria-hidden="true"
    ></span>
    <span class="habit-name">{row.name}</span>
  </div>

  <div class="habit-streak">
    {#if isDormant}
      <span class="streak-muted" title="No active streak">—</span>
    {:else}
      <span class="streak-num">{streak.count}</span>
      <span class="streak-unit">{unit}</span>
    {/if}
  </div>

  <div class="habit-strip" aria-label="Recent progress">
    {#if useProportional && proportional}
      <span class="proportional" title="{proportional.filled} of {proportional.target} this {row.period}">
        {proportional.filled}/{proportional.target}
      </span>
    {:else}
      {#each squares as sq}
        <HabitSquare state={sq.state} {colorIndex} label={sq.label} />
      {/each}
      {#if overflow > 0}
        <span class="overflow" title="{overflow} extra this {row.period}">+{overflow}</span>
      {/if}
    {/if}
  </div>
</div>

<style>
  .habit-summary {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 0;
  }

  .habit-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .habit-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }

  .habit-name {
    font-size: 14px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .habit-streak {
    display: flex;
    align-items: baseline;
    gap: 4px;
    flex: 0 0 auto;
  }

  .streak-num {
    font-size: 15px;
    font-weight: 600;
    font-family: var(--font-mono);
    color: var(--text-primary);
  }

  .streak-unit {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .streak-muted {
    font-size: 15px;
    color: var(--text-tertiary);
  }

  .habit-strip {
    display: flex;
    align-items: center;
    gap: 3px;
    flex: 0 0 auto;
  }

  .overflow {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    margin-left: 2px;
  }

  .proportional {
    font-size: 13px;
    font-family: var(--font-mono);
    color: var(--text-primary);
  }
</style>
