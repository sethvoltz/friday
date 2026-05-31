<script lang="ts">
  import type { Snippet } from "svelte";
  import { shouldShowToggle } from "./collapsible-toggle";

  // Shared "shown-directly, height-capped, expand-for-more" primitive
  // (FRI-130). Renders its content directly; when collapsed AND the content
  // overflows the cap, the content is clamped to `collapsedMaxHeight` (px)
  // with `overflow-y: auto`, and a single disclosure control toggles between
  // the clamp and full height.
  //
  // FRI-137 — smart toggle: the disclosure control + the clamp are rendered
  // ONLY when the content actually exceeds `collapsedMaxHeight`. A section
  // whose content already fits shows in full with NO toggle and no clamp
  // (a 1–2 line file edit / a 3-row todo list no longer gets a useless
  // expand affordance). Overflow is measured from the body's `scrollHeight`
  // (which reports full content height even while clamped) via a
  // `ResizeObserver`; the pure derivation lives in `collapsible-toggle.ts`.
  //
  // Encodes the disclosure-glyph convention (docs/ui-conventions.md): the
  // `+` (collapsed) / `−` (expanded) glyph is rendered inside the clickable
  // element with `aria-hidden="true"`, and the button carries
  // `aria-expanded={open}`. Only the plus/minus glyphs — no other
  // disclosure iconography.
  interface Props {
    /** Optional label shown next to the built-in disclosure glyph. Ignored
     *  when a `header` snippet is supplied (the header owns the control). */
    label?: string;
    /** Collapsed clamp height in px (default 320). */
    collapsedMaxHeight?: number;
    /** Initial expansion state when `open` is not bound (default false). */
    startOpen?: boolean;
    /** Extra class applied to the body wrapper. */
    class?: string;
    /** Expansion state — `$bindable` so a parent renderer can read/drive it. */
    open?: boolean;
    /**
     * Optional caller-supplied header that becomes the disclosure control
     * (FRI-137). When provided, the built-in label+button is NOT rendered;
     * the header snippet receives `{ open, toggle, showToggle }` so the
     * caller can render its own clickable header row (e.g. filename + status
     * badge + `+`/`−` glyph) as the toggle. `showToggle` is `false` when the
     * content fits within the cap, so the caller renders a non-interactive
     * header (no glyph, no `aria-expanded`) in that case.
     */
    header?: Snippet<[{ open: boolean; toggle: () => void; showToggle: boolean }]>;
    children: Snippet;
  }
  let {
    label,
    collapsedMaxHeight = 320,
    startOpen = false,
    class: className = "",
    open = $bindable(startOpen),
    header,
    children,
  }: Props = $props();

  // Measured full content height (px). Starts at 0 (unknown); the
  // ResizeObserver below populates it after first layout and on every
  // content reflow (e.g. Shiki swapping in highlighted markup).
  let bodyEl = $state<HTMLDivElement | null>(null);
  let measuredHeight = $state(0);

  $effect(() => {
    const el = bodyEl;
    if (!el) return;
    const measure = () => {
      // `scrollHeight` reports the full content height regardless of the
      // active `max-height` clamp, so we get the true overflow signal even
      // while collapsed.
      measuredHeight = el.scrollHeight;
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  });

  let showToggle = $derived(shouldShowToggle(measuredHeight, collapsedMaxHeight));
  function toggle() {
    open = !open;
  }
</script>

<div class="collapsible">
  {#if header}
    {@render header({ open, toggle, showToggle })}
  {:else if showToggle}
    <button
      type="button"
      class="collapsible-toggle"
      onclick={toggle}
      aria-expanded={open}>
      <span class="glyph" aria-hidden="true">{open ? "−" : "+"}</span>
      {#if label}
        <span class="collapsible-label">{label}</span>
      {/if}
    </button>
  {:else if label}
    <!-- Content fits: render the label as a non-interactive header (no glyph,
         no aria-expanded) so the section still reads as labeled. -->
    <span class="collapsible-toggle collapsible-static">
      <span class="collapsible-label">{label}</span>
    </span>
  {/if}
  <div
    bind:this={bodyEl}
    class="collapsible-body {className}"
    class:clamped={showToggle && !open}
    style={showToggle && !open ? `max-height: ${collapsedMaxHeight}px` : ""}>
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
  .collapsible-static {
    cursor: default;
  }
  .collapsible-static:hover {
    background: transparent;
    color: var(--text-tertiary);
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
  /* Only the clamped (collapsed-and-overflowing) state needs the scroll
     container. When the content fits, the body has no max-height and no
     overflow region — so a fits-content section contributes ZERO scrollable
     regions (file-edit-diff.spec.ts counts overflow-y:auto + max-height). */
  .collapsible-body.clamped {
    overflow-y: auto;
  }
</style>
