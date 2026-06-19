<script lang="ts">
  // FRI-169 — the Today card's tap-to-check-off control for one expected
  // habit. Renders the habit name, a compact numeric Streak, and a toggle
  // that checks the habit off for the current Period.
  //
  // The WRITE is owned by the parent (the Today card wires the
  // `zeroSync.habitCheckin` / `habitCheckinUndo` mutators) — this component
  // only surfaces intent via `oncheck` / `onundo` callbacks, so the
  // component kit stays free of the store dependency the prompt reserves
  // for the route layer.
  //
  // Accessibility: the control is a real <button> with aria-pressed
  // reflecting whether the current Period is already satisfied.

  import {
    habitStreak,
    isCheckedOnDay,
    type ZeroHabitRow,
    type ZeroHabitCheckinRow,
  } from "$lib/habits/adapt";

  interface Props {
    row: ZeroHabitRow;
    checkins: ZeroHabitCheckinRow[];
    now?: Date;
    /** Called when the user checks the habit off (parent does the write). */
    oncheck?: (row: ZeroHabitRow) => void;
    /** Called when the user undoes today's check-off. */
    onundo?: (row: ZeroHabitRow) => void;
    /** Disable while a write is in flight. */
    busy?: boolean;
  }

  let { row, checkins, now = new Date(), oncheck, onundo, busy = false }: Props =
    $props();

  const colorIndex = $derived(
    row.color_index != null && row.color_index >= 1 && row.color_index <= 7
      ? row.color_index
      : 1,
  );

  const streak = $derived(habitStreak(row, checkins, now));
  // Pressed iff the habit has been checked off TODAY — not iff the whole
  // Period target is met. A multi-per-Period habit (e.g. 3×/week) stays
  // unsatisfied after one Check-in, so keying the checkbox on satisfaction
  // left a check-off invisible on the Today card (FRI-169 follow-up).
  const pressed = $derived(isCheckedOnDay(checkins, now));
  const count = $derived(streak.count);

  // Progress within the current (open) Period, shown for multi-target habits
  // so partial progress (e.g. 1/3 this week) is visible even before the
  // Period is satisfied.
  const progress = $derived(streak.currentPeriodProgress);
  const showProgress = $derived(row.target > 1);

  function toggle() {
    if (busy) return;
    if (pressed) onundo?.(row);
    else oncheck?.(row);
  }
</script>

<button
  type="button"
  class="habit-check"
  class:pressed
  style="--check-color: var(--habit-{colorIndex});"
  aria-pressed={pressed}
  aria-label={pressed
    ? `Undo check-off for ${row.name}`
    : `Check off ${row.name}`}
  disabled={busy}
  onclick={toggle}
>
  <span class="check-box" aria-hidden="true">
    {#if pressed}
      <svg viewBox="0 0 16 16" class="check-glyph" width="14" height="14">
        <path
          d="M3.5 8.5l3 3 6-7"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    {/if}
  </span>
  <span class="check-name">{row.name}</span>
  {#if showProgress}
    <span
      class="check-progress"
      title="{progress.filled} of {progress.target} this {row.period}"
      >{progress.filled}/{progress.target}</span
    >
  {/if}
  {#if count > 0}
    <span class="check-streak" title="{count} period streak">{count}</span>
  {/if}
</button>

<style>
  .habit-check {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm, 8px);
    background: var(--bg-card);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast, 120ms) ease,
      border-color var(--transition-fast, 120ms) ease;
  }

  .habit-check:hover:not(:disabled) {
    background: var(--bg-card-hover);
  }

  .habit-check:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  .habit-check:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .check-box {
    width: 20px;
    height: 20px;
    border-radius: var(--radius-sm, 5px);
    border: 2px solid var(--border-primary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    color: var(--text-inverse);
  }

  .habit-check.pressed .check-box {
    background: var(--check-color);
    border-color: var(--check-color);
  }

  .check-name {
    flex: 1 1 auto;
    font-size: 14px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .check-progress {
    flex: 0 0 auto;
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-secondary);
  }

  .check-streak {
    flex: 0 0 auto;
    font-size: 12px;
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text-secondary);
  }
</style>
