<script lang="ts">
  /**
   * Three-stage connectivity widget (FIX_FORWARD 3.10).
   *
   *   (●) 🌐  ⋯▸  (●) 📡  ⋯▸  (●) 🖥  · up 6h 10m
   *
   * Each (dot, icon) pair is a hoverable / tappable unit with a tooltip
   * via `title`. Informational only — no buttons. The uptime tail is
   * hidden on mobile to keep the header compact; tapping stage 3 there
   * shows the uptime in its tooltip.
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
    <span class="dot"></span>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  </span>
  <svg class="sep" viewBox="0 0 20 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="1" y1="7" x2="13" y2="7" stroke-dasharray="2 3" />
    <polyline points="12,4 16,7 12,10" />
  </svg>
  <span
    class={statusClass(view.sse.status)}
    title={view.sse.tooltip}
    aria-label={view.sse.tooltip}>
    <span class="dot"></span>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 10a7.31 7.31 0 0 0 10 10Z" />
      <path d="m9 15 3-3" />
      <path d="M17 13a6 6 0 0 0-6-6" />
      <path d="M21 13A10 10 0 0 0 11 3" />
    </svg>
  </span>
  <svg class="sep" viewBox="0 0 20 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <line x1="1" y1="7" x2="13" y2="7" stroke-dasharray="2 3" />
    <polyline points="12,4 16,7 12,10" />
  </svg>
  <span
    class={statusClass(view.daemon.status)}
    title={view.daemon.tooltip}
    aria-label={view.daemon.tooltip}>
    <span class="dot"></span>
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
    <span class="uptime desktop-only" aria-label={`Daemon uptime ${formatUptime(view.uptimeMs)}`}>
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
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
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
    width: 20px;
    height: 14px;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }
  .icon {
    width: 14px;
    height: 14px;
    color: var(--stage-color);
    transition: color 200ms ease;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--stage-color);
    /* The animation is ALWAYS running on every dot — that's how we keep
       the three pulses in sync. State transitions mutate `--stage-color`
       only; the timeline never restarts. `color-mix` re-resolves each
       frame so the halo follows the dot's current color. */
    animation: stage-pulse 1.6s ease-out infinite;
    transition: background-color 200ms ease;
  }
  @keyframes stage-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--stage-color) 65%, transparent); }
    70%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--stage-color) 0%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--stage-color) 0%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot { animation: none; }
  }

  .uptime {
    color: var(--text-tertiary);
    margin-left: 0.15rem;
  }
  /* Hide uptime on mobile — daemon stage tooltip carries it instead. */
  @media (max-width: 768px) {
    .desktop-only { display: none; }
  }
</style>
