<script lang="ts">
  // FRI-169 — one Slot square. Reuses the ActivityGrid `ag-cell` square
  // shape (10px rounded square) but draws the three Slot states from the
  // glossary (CONTEXT.md ### Habits → Slot):
  //   empty   — outline only (not yet missed)
  //   filled  — the Habit color, var(--habit-{colorIndex})
  //   slashed — a light diagonal slash over an empty square (a miss)
  //
  // Color comes ONLY from the active Palette's habit ramp via
  // var(--habit-N); never a hardcoded hue (Habit color contract).

  import type { SlotState } from "@friday/shared/habits";

  interface Props {
    state: SlotState;
    /** Habit color slot 1..7. Falls back to slot 1 when absent. */
    colorIndex?: number | null;
    /** Optional accessible label (e.g. "Mon Jun 15 — done"). */
    label?: string;
    /** Square edge in px; defaults to the ag-cell 10px. */
    size?: number;
  }

  let { state, colorIndex = 1, label, size = 10 }: Props = $props();

  // Clamp to the 1..7 ramp; any out-of-range index pins to slot 1 so a bad
  // value renders a color rather than an unresolved var.
  const slot = $derived(
    colorIndex != null && colorIndex >= 1 && colorIndex <= 7 ? colorIndex : 1,
  );
  const fill = $derived(`var(--habit-${slot})`);
</script>

<span
  class="habit-square {state}"
  style="--sq-size: {size}px; --sq-fill: {fill};"
  role="img"
  aria-label={label ?? state}
  title={label}
></span>

<style>
  /* Mirror the ag-cell geometry: small rounded square, no padding. */
  .habit-square {
    display: inline-block;
    width: var(--sq-size, 10px);
    height: var(--sq-size, 10px);
    border-radius: 2px;
    box-sizing: border-box;
    flex: 0 0 auto;
    position: relative;
  }

  /* empty — outline only, on the palette's empty-grid tone. */
  .habit-square.empty {
    background: var(--grid-empty);
    border: 1px solid var(--border-primary);
  }

  /* filled — the Habit color from the active Palette's habit ramp. */
  .habit-square.filled {
    background: var(--sq-fill);
    border: 1px solid transparent;
  }

  /* slashed — an empty square with a light diagonal slash: an
     expected-but-missed Slot. The slash is drawn as a thin gradient band
     so it inherits the palette's border tone and stays crisp at 10px. */
  .habit-square.slashed {
    background: var(--grid-empty);
    border: 1px solid var(--border-subtle);
    background-image: linear-gradient(
      135deg,
      transparent 0%,
      transparent calc(50% - 0.75px),
      var(--text-tertiary) calc(50% - 0.75px),
      var(--text-tertiary) calc(50% + 0.75px),
      transparent calc(50% + 0.75px),
      transparent 100%
    );
  }
</style>
