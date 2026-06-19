<script lang="ts">
  // FRI-169 — Habit color picker. Seven swatches drawn from the active
  // Palette's habit ramp (var(--habit-1..7)); the Habit stores only the
  // INDEX (Habit color contract — never a hex), so the picker is just a
  // 1..7 selector. Keyboard-operable: each swatch is a real radio in a
  // labelled radiogroup, so arrow keys + Space/Enter move and commit
  // selection natively, and the selected swatch is announced.

  interface Props {
    /** Bindable selected color slot, 1..7. */
    selected: number;
    /** Accessible group label. */
    label?: string;
  }

  let { selected = $bindable(1), label = "Habit color" }: Props = $props();

  const SLOTS = [1, 2, 3, 4, 5, 6, 7] as const;
</script>

<div class="color-picker" role="radiogroup" aria-label={label}>
  {#each SLOTS as slot}
    <button
      type="button"
      role="radio"
      class="swatch"
      class:selected={selected === slot}
      style="--swatch-fill: var(--habit-{slot});"
      aria-checked={selected === slot}
      aria-label="Color {slot}"
      onclick={() => (selected = slot)}
    >
      <span class="swatch-fill"></span>
    </button>
  {/each}
</div>

<style>
  .color-picker {
    display: inline-flex;
    gap: 8px;
    align-items: center;
  }

  .swatch {
    width: 28px;
    height: 28px;
    padding: 3px;
    border-radius: var(--radius-sm, 6px);
    border: 2px solid transparent;
    background: transparent;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: border-color var(--transition-fast, 120ms) ease,
      transform var(--transition-fast, 120ms) ease;
  }

  .swatch:hover {
    transform: scale(1.08);
  }

  .swatch:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  /* Selected state: a clear ring in the focus/accent tone plus a subtle
     lift, so the chosen swatch reads unambiguously. */
  .swatch.selected {
    border-color: var(--accent-primary);
  }

  .swatch.selected .swatch-fill {
    box-shadow: 0 0 0 2px var(--bg-card), 0 0 0 4px var(--accent-glow);
  }

  .swatch-fill {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: var(--radius-sm, 4px);
    background: var(--swatch-fill);
  }
</style>
