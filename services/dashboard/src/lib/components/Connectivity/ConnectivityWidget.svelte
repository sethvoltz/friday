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
    <span class="dot" class:pulse={view.internet.status === "live" || view.internet.status === "reconnecting"}></span>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  </span>
  <span class="sep" aria-hidden="true">⋯▸</span>
  <span
    class={statusClass(view.sse.status)}
    title={view.sse.tooltip}
    aria-label={view.sse.tooltip}>
    <span class="dot" class:pulse={view.sse.status === "live" || view.sse.status === "reconnecting"}></span>
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 12.55a11 11 0 0 1 14 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  </span>
  <span class="sep" aria-hidden="true">⋯▸</span>
  <span
    class={statusClass(view.daemon.status)}
    title={view.daemon.tooltip}
    aria-label={view.daemon.tooltip}>
    <span class="dot" class:pulse={view.daemon.status === "live" || view.daemon.status === "reconnecting"}></span>
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
  .widget {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
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
    cursor: help;
  }
  .stage:hover {
    background: var(--bg-tertiary);
  }
  .sep {
    color: var(--text-tertiary);
    user-select: none;
  }
  .icon {
    width: 14px;
    height: 14px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  /* Status palettes. Pulse animation triggers on live/reconnecting; static
     on down/unknown. */
  .stage-live { color: var(--status-ok); }
  .stage-live .dot { background: var(--status-ok); }
  .stage-reconnecting { color: var(--status-warn); }
  .stage-reconnecting .dot { background: var(--status-warn); }
  .stage-down { color: var(--status-error); }
  .stage-down .dot { background: var(--status-error); }
  .stage-unknown { color: var(--text-tertiary); }
  .stage-unknown .dot { background: var(--text-tertiary); }

  .dot.pulse {
    animation: dot-pulse 1.6s ease-out infinite;
  }
  @keyframes dot-pulse {
    0%   { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 70%, transparent); }
    70%  { box-shadow: 0 0 0 6px color-mix(in srgb, currentColor 0%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 0%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.pulse { animation: none; }
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
