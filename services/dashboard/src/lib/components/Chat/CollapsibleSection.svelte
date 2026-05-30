<script lang="ts">
  import type { Snippet } from "svelte";

  // Shared "shown-directly, height-capped, expand-for-more" primitive
  // (FRI-130). Renders its content directly; when collapsed, the content is
  // clamped to `collapsedMaxHeight` (px) with `overflow-y: auto`, and a
  // single disclosure control toggles between the clamp and full height.
  //
  // Encodes the disclosure-glyph convention (docs/ui-conventions.md): the
  // `+` (collapsed) / `−` (expanded) glyph is rendered inside the clickable
  // element with `aria-hidden="true"`, and the button carries
  // `aria-expanded={open}`. Only the plus/minus glyphs — no other
  // disclosure iconography.
  interface Props {
    /** Optional label shown next to the disclosure glyph. */
    label?: string;
    /** Collapsed clamp height in px (default 320). */
    collapsedMaxHeight?: number;
    /** Initial expansion state when `open` is not bound (default false). */
    startOpen?: boolean;
    /** Extra class applied to the body wrapper. */
    class?: string;
    /** Expansion state — `$bindable` so a parent renderer can read/drive it. */
    open?: boolean;
    children: Snippet;
  }
  let {
    label,
    collapsedMaxHeight = 320,
    startOpen = false,
    class: className = "",
    open = $bindable(startOpen),
    children,
  }: Props = $props();
</script>

<div class="collapsible">
  <button
    type="button"
    class="collapsible-toggle"
    onclick={() => (open = !open)}
    aria-expanded={open}>
    <span class="glyph" aria-hidden="true">{open ? "−" : "+"}</span>
    {#if label}
      <span class="collapsible-label">{label}</span>
    {/if}
  </button>
  <div
    class="collapsible-body {className}"
    style="max-height: {open ? 'none' : collapsedMaxHeight + 'px'}">
    {@render children()}
  </div>
</div>

<style>
  .collapsible {
    display: flex;
    flex-direction: column;
  }
  .collapsible-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    align-self: flex-start;
    background: transparent;
    border: none;
    color: var(--text-tertiary);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0.15rem 0.4rem;
    border-radius: var(--radius-sm);
  }
  .collapsible-toggle:hover {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
  }
  .glyph {
    font-family: var(--font-mono);
    font-size: 1rem;
    line-height: 1;
    width: 1rem;
    text-align: center;
  }
  .collapsible-label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .collapsible-body {
    overflow-y: auto;
  }
</style>
