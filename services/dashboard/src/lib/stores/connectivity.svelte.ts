/**
 * Connectivity-chain widget store (FIX_FORWARD 3.10).
 *
 * Three stages — Internet, Sync, Daemon — each with a status:
 *   - "live":         green, pulsing
 *   - "reconnecting": orange, pulsing
 *   - "down":         red, static
 *   - "unknown":      grey, static (a strictly earlier stage is not "live")
 *
 * Phase 6 (plan §224): the middle stage is now **Sync** — Zero's
 * WebSocket-to-zero-cache health is the primary signal, because most
 * dashboard reads ride Zero (agents, blocks, tickets, schedules, mail,
 * memory, apps, settings, client_devices, read_cursors). The SSE
 * stream is now narrow (live-turn-only deltas) and surfaces as a
 * sub-component in the Sync tooltip.
 *
 * The Internet stage is derived primarily from `navigator.onLine` and
 * `online` / `offline` events. Stages 2 and 3 derive from the Zero
 * client's status, SSE connection state, and `chat.bootId` /
 * `chat.bootTs`.
 */

import { chat } from "./chat.svelte";
import { sseConnected } from "./sse.svelte";
import { zeroSync } from "./zero.svelte";

export type StageStatus = "live" | "reconnecting" | "down" | "unknown";

const SUCCESS_FRESH_MS = 30_000;
const SUCCESS_STALE_MS = 60_000;

class Connectivity {
  /** Mirrors navigator.onLine — true unless the browser said we're offline. */
  online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);
  /** Last time the client confirmed it reached the daemon (any successful
   *  same-origin fetch / SSE chunk). Used by stage 1 to distinguish
   *  "browser thinks we're online" from "we actually got bytes back". */
  lastSuccessAt = $state<number>(0);
  /** Tracks whether at least one daemon-proxy fetch is currently in
   *  flight. Used by stage 1 to render the orange "reconnecting" pulse
   *  while we don't yet have a fresh success but a request is pending. */
  inFlight = $state(0);
  /** Bumped by setInterval to force re-derivation of time-sensitive
   *  status (the "older than 30s" check on lastSuccessAt + uptime tail). */
  tick = $state(0);

  markSuccess(): void {
    this.lastSuccessAt = Date.now();
  }
  beginFetch(): void {
    this.inFlight += 1;
  }
  endFetch(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }
}

export const connectivity = new Connectivity();

/** Wire `online` / `offline` listeners + a 5s tick that refreshes
 *  time-based status. Idempotent; safe to call from layout.svelte. */
let started = false;
let tickInterval: ReturnType<typeof setInterval> | null = null;
export function startConnectivity(): void {
  if (started) return;
  started = true;
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      connectivity.online = true;
    });
    window.addEventListener("offline", () => {
      connectivity.online = false;
    });
  }
  tickInterval = setInterval(() => {
    connectivity.tick += 1;
  }, 5_000);
  // Node returns a Timeout object; the browser returns a number. The
  // `in` check would throw `TypeError` on the primitive, so probe via
  // typeof first.
  if (
    tickInterval !== null &&
    typeof tickInterval === "object" &&
    "unref" in tickInterval
  ) {
    (tickInterval as { unref?: () => void }).unref?.();
  }
}

export function stopConnectivity(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  started = false;
}

export interface StageView {
  status: StageStatus;
  label: string;
  tooltip: string;
}

export interface WidgetView {
  internet: StageView;
  sync: StageView;
  daemon: StageView;
  uptimeMs: number | null;
}

/**
 * Resolve all three stages from current store state. Pure: no side
 * effects, no time references beyond `connectivity.tick` (re-runs as the
 * tick bumps, refreshing the "older than 30s" judgement).
 */
export function resolveWidget(): WidgetView {
  // Touch `tick` so callers wrapped in `$derived` re-evaluate on each
  // interval bump.
  const _ = connectivity.tick;
  void _;
  const now = Date.now();
  // `lastSuccessAt` is bumped by every SSE chunk we read. It's a proxy
  // for "the SSE stream is delivering bytes" — *not* general internet
  // reachability. We only treat its absence as a signal once we've had
  // at least one success; otherwise a fresh page load would always
  // start "stale" simply because no chunk has arrived yet.
  const haveSuccess = connectivity.lastSuccessAt > 0;
  const sseFresh =
    haveSuccess && now - connectivity.lastSuccessAt < SUCCESS_FRESH_MS;
  const sseStale =
    haveSuccess && now - connectivity.lastSuccessAt > SUCCESS_STALE_MS;

  // Stage 1 — Internet. The page itself rendered, so we know HTTP works
  // when the dashboard server is reachable from the browser. The honest
  // signal here is just `navigator.onLine`; SSE-chunk freshness belongs
  // to stage 2.
  const internet: StageStatus = connectivity.online ? "live" : "down";

  // Stage 2 — Sync. Phase 6: Zero WS health is the primary signal.
  // The Zero client's `status` field reports "pending" (still
  // connecting / no JWT yet), "live" (WS open + handshake done), or
  // "error" (terminal — auth failure or schema mismatch). SSE
  // sub-health surfaces in the tooltip; SSE-down with Zero-live is
  // an acceptable degraded state (most reads still work).
  const zeroStatus = zeroSync.status;
  let sync: StageStatus;
  if (internet !== "live") {
    sync = "unknown";
  } else if (zeroStatus === "live") {
    sync = "live";
  } else if (zeroStatus === "pending") {
    sync = "reconnecting";
  } else {
    sync = "down";
  }

  // SSE sub-health (folded into the Sync tooltip, not its own stage).
  let sseHealth: StageStatus;
  if (internet !== "live") {
    sseHealth = "unknown";
  } else if (!sseConnected.value) {
    sseHealth = "reconnecting";
  } else if (sseStale) {
    sseHealth = "reconnecting";
  } else if (sseFresh || !haveSuccess) {
    sseHealth = "live";
  } else {
    sseHealth = "reconnecting";
  }

  let daemon: StageStatus;
  if (sync !== "live") {
    daemon = "unknown";
  } else if (chat.bootId !== null) {
    daemon = "live";
  } else {
    daemon = "reconnecting";
  }

  const uptimeMs = chat.bootTs ? Math.max(0, Date.now() - chat.bootTs) : null;

  return {
    internet: {
      status: internet,
      label: "Internet",
      tooltip: internetTooltip(internet),
    },
    sync: {
      status: sync,
      label: "Sync",
      tooltip: syncTooltip(sync, sseHealth, sseFresh, sseStale, haveSuccess),
    },
    daemon: {
      status: daemon,
      label: "Daemon",
      tooltip: daemonTooltip(daemon, uptimeMs),
    },
    uptimeMs,
  };
}

function internetTooltip(s: StageStatus): string {
  if (s === "down") return "Internet — browser is offline (navigator.onLine = false)";
  return "Internet — browser is online";
}

function syncTooltip(
  zero: StageStatus,
  sse: StageStatus,
  fresh: boolean,
  stale: boolean,
  haveSuccess: boolean,
): string {
  // Phase 6: Sync == Zero WS health; SSE sub-health folded in.
  if (zero === "unknown") return "Sync — waiting on internet";
  const zeroText =
    zero === "live"
      ? "Sync — Zero WS live"
      : zero === "down"
        ? "Sync — Zero WS down (auth or schema error)"
        : "Sync — Zero WS reconnecting";
  let sseText: string;
  if (sse === "unknown") sseText = "SSE waiting";
  else if (sse === "live")
    sseText = fresh ? "SSE live (< 30s)" : "SSE live";
  else if (sse === "down") sseText = "SSE down";
  else if (stale) sseText = "SSE stale (no frame 60s+)";
  else if (!haveSuccess) sseText = "SSE connecting";
  else sseText = "SSE reconnecting";
  return `${zeroText} · ${sseText}`;
}

function daemonTooltip(s: StageStatus, uptimeMs: number | null): string {
  if (s === "unknown") return "Daemon — waiting on Sync";
  if (s !== "live") return "Daemon — reconnecting";
  if (uptimeMs === null) return "Daemon — live";
  return `Daemon — live · up ${formatUptime(uptimeMs)}`;
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
