<script lang="ts">
  interface Props {
    /** Bind: the toggle state. */
    checked: boolean;
    /** Optional text shown to the right of the knob. Clicking it also toggles. */
    label?: string;
    /** Native title attribute (tooltip). */
    title?: string;
    /** Render as a full-width row with hover background — useful in lists
     * (e.g. the sidebar filters). Defaults to false (compact inline). */
    block?: boolean;
    /** Lock the toggle while a parent operation is in flight. */
    disabled?: boolean;
  }
  let {
    checked = $bindable(),
    label,
    title,
    block = false,
    disabled = false,
  }: Props = $props();
</script>

<label class="toggle" class:block class:disabled {title}>
  <input type="checkbox" bind:checked {disabled} />
  <span class="track"><span class="knob"></span></span>
  {#if label}<span class="lbl">{label}</span>{/if}
</label>

<style>
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    user-select: none;
  }
  .toggle.disabled {
    cursor: default;
    opacity: 0.6;
  }
  .toggle.block {
    display: flex;
    width: 100%;
    padding: 0.3rem 0.4rem;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 0.8rem;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .toggle.block:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .toggle input[type="checkbox"] {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }

  .track {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 30px;
    height: 17px;
    border-radius: 9px;
    background: var(--border-primary);
    transition: background var(--transition-fast);
    flex-shrink: 0;
  }
  .toggle input[type="checkbox"]:checked ~ .track {
    background: var(--accent-primary);
  }

  .knob {
    position: absolute;
    left: 2px;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: #fff;
    transition: transform var(--transition-fast);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  }
  .toggle input[type="checkbox"]:checked ~ .track .knob {
    transform: translateX(13px);
  }

  .lbl {
    font-size: inherit;
    color: inherit;
    line-height: 1;
  }
  .toggle:not(.block) .lbl {
    font-size: 0.72rem;
    color: var(--text-tertiary);
  }

  /* Focus ring for keyboard users — the input is visually hidden, so put
     a ring on the track when the input is focus-visible. Matches the
     universal focus ring in app.css (2px solid --border-focus). The
     global rule can't reach this case because <input type="checkbox">
     isn't a/button/[role="button"] and the input itself is zero-sized,
     so the visible affordance lives on the sibling track. */
  .toggle input[type="checkbox"]:focus-visible ~ .track {
    box-shadow: 0 0 0 2px var(--border-focus);
  }
</style>
