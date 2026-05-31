<script lang="ts">
  /**
   * Three-stage connectivity widget (FIX_FORWARD 3.10).
   *
   *   🌐  ⋯▸  📡  ⋯▸  🖥  · up 6h 10m
   *
   * Each icon is a hoverable / tappable unit with a tooltip via `title`.
   * Status reads off the icon's own color, with a pulsing halo behind it
   * when the stage is active (green) or reconnecting (orange). Down (red)
   * and unknown (grey) stay static. Informational only — no buttons. The
   * uptime tail shows at every width (it also lives in stage 3's tooltip).
   */
  import {
    formatUptime,
    resolveWidget,
    type StageView,
  } from "$lib/stores/connectivity.svelte";

  let view = $derived(resolveWidget());

  function statusClass(s: StageView["status"]): string {
    return `stage stage-${s}`;
  }
</script>

<div class="widget" role="status" aria-label="Connectivity">
  <span
    class={statusClass(view.internet.status)}
    title={view.internet.tooltip}
    aria-label={view.internet.tooltip}>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  </span>
  <svg class="sep" viewBox="0 0 15 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="1" y1="7" x2="8" y2="7" stroke-dasharray="2 3" />
    <polyline points="7,4 11,7 7,10" />
  </svg>
  <span
    class={statusClass(view.sync.status)}
    title={view.sync.tooltip}
    aria-label={view.sync.tooltip}>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <!-- Satellite-dish glyph. Phase 6a rewired the middle stage from
           SSE → Sync semantics but the dish icon reads more clearly as
           "signal" than the refresh arrows did; keep the dish, the
           binding still resolves Zero WS health via `view.sync`. -->
      <path d="M4 10a7.31 7.31 0 0 0 10 10Z" />
      <path d="m9 15 3-3" />
      <path d="M17 13a6 6 0 0 0-6-6" />
      <path d="M21 13A10 10 0 0 0 11 3" />
    </svg>
  </span>
  <svg class="sep" viewBox="0 0 15 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="1" y1="7" x2="8" y2="7" stroke-dasharray="2 3" />
    <polyline points="7,4 11,7 7,10" />
  </svg>
  <span
    class={statusClass(view.daemon.status)}
    title={view.daemon.tooltip}
    aria-label={view.daemon.tooltip}>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="2" x2="9" y2="4" />
      <line x1="15" y1="2" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="22" />
      <line x1="15" y1="20" x2="15" y2="22" />
      <line x1="20" y1="9" x2="22" y2="9" />
      <line x1="20" y1="14" x2="22" y2="14" />
      <line x1="2" y1="9" x2="4" y2="9" />
      <line x1="2" y1="14" x2="4" y2="14" />
    </svg>
  </span>
  {#if view.uptimeMs !== null && view.daemon.status === "live"}
    <span class="uptime" aria-label={`Daemon uptime ${formatUptime(view.uptimeMs)}`}>
      · up {formatUptime(view.uptimeMs)}
    </span>
  {/if}
</div>

<style>
  /* One CSS variable per stage — `--stage-color` is the single source of
     truth for the dot fill, icon stroke, and pulse halo. State transitions
     only mutate this variable, never the animation itself, so the three
     dots stay in phase across status changes. */
  .stage-live { --stage-color: var(--status-ok); }
  .stage-reconnecting { --stage-color: var(--status-warn); }
  .stage-down { --stage-color: var(--status-error); }
  .stage-unknown { --stage-color: var(--text-tertiary); }

  .widget {
    display: inline-flex;
    align-items: center;
    gap: 0.05rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }
  .stage {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.3rem;
    border-radius: var(--radius-sm);
    color: var(--stage-color);
    cursor: help;
    transition: color 200ms ease;
  }
  .stage:hover {
    background: var(--bg-tertiary);
  }
  .sep {
    width: 15px;
    height: 14px;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }
  .icon {
    position: relative;
    z-index: 1;
    width: 16px;
    height: 16px;
    color: var(--stage-color);
    transition: color 200ms ease;
  }
  /* The pulse halo now lives on a pseudo-element centered behind the
     icon (the standalone dot is gone). It runs on `.stage-live` (green,
     "active") and `.stage-reconnecting` (orange, "trying to reconnect").
     `.stage-down` (red) and `.stage-unknown` (grey) stay static because
     there's nothing happening to communicate. The timeline lives on the
     element itself rather than a per-state rule so the green↔orange
     transition keeps a single continuous timeline instead of restarting
     the keyframe at 0%. `color-mix` re-resolves each frame so the halo
     follows the icon's current color. */
  .stage::before {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 0;
    width: 6px;
    height: 6px;
    margin: -3px 0 0 -3px;
    border-radius: 50%;
    pointer-events: none;
    animation: stage-pulse 1.6s ease-out infinite;
  }
  .stage-down::before,
  .stage-unknown::before {
    animation: none;
    box-shadow: none;
  }
  @keyframes stage-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--stage-color) 65%, transparent); }
    70%  { box-shadow: 0 0 0 9px color-mix(in srgb, var(--stage-color) 0%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--stage-color) 0%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    .stage::before { animation: none; }
  }

  .uptime {
    color: var(--text-tertiary);
    margin-left: 0.15rem;
    white-space: nowrap;
  }
</style>
