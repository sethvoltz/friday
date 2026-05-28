<script lang="ts">
  import type { PaletteName } from "$lib/theme/palettes";

  interface Props {
    palette: PaletteName;
    label: string;
  }

  let { palette, label }: Props = $props();

  // The parent `<button class="palette-{name}">` wraps this component
  // in the named palette's CSS scope, so every `var(--*)` inside this
  // template resolves against THAT palette's tokens — not the active
  // palette's. This is the key to AC #25 (each preview renders in its
  // own scope regardless of which palette the user is currently using).
  // FRI-124 v1: minimalist preview (palette name + small swatch row).
  // Task #15 grows this into the full mini-page mock (chat exchange,
  // status pills, aurora hint).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void palette;
</script>

<div class="preview">
  <div class="preview-header">{label}</div>
  <div class="preview-swatches" aria-hidden="true">
    <span class="sw sw-bg" style="background: var(--bg-primary)"></span>
    <span class="sw sw-card" style="background: var(--bg-card)"></span>
    <span class="sw sw-accent" style="background: var(--accent-primary)"></span>
    <span class="sw sw-ok" style="background: var(--status-ok)"></span>
    <span class="sw sw-warn" style="background: var(--status-warn)"></span>
    <span class="sw sw-error" style="background: var(--status-error)"></span>
  </div>
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    background: var(--bg-card);
    color: var(--text-primary);
    padding: 0.75rem 0.85rem;
    gap: 0.55rem;
  }
  .preview-header {
    font-size: 0.9rem;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-primary);
  }
  .preview-swatches {
    display: flex;
    gap: 0.3rem;
  }
  .sw {
    flex: 1;
    height: 14px;
    border-radius: 3px;
    border: 1px solid var(--border-subtle);
  }
</style>
