/**
 * Connectivity-chain widget store (FIX_FORWARD 3.10).
 *
 * Three stages — Internet, SSE, Daemon — each with a status:
 *   - "live":         green, pulsing
 *   - "reconnecting": orange, pulsing
 *   - "down":         red, static
 *   - "unknown":      grey, static (a strictly earlier stage is not "live")
 *
 * The Internet stage is derived primarily from `navigator.onLine` and
 * `online` / `offline` events, with a "recent same-origin success"
 * timestamp the SSE handler bumps whenever it parses an event chunk
 * (every successful daemon-proxy round-trip is implicit proof that the
 * client → daemon path is reachable). Stages 2 and 3 derive from the SSE
 * manager and `chat.bootId` / `chat.bootTs`.
 */

import { chat } from "./chat.svelte";
import { sseConnected } from "./sse.svelte";

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
  sse: StageView;
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

  // Stage 2 — SSE. Cascades grey if internet isn't live. Otherwise:
  // connected + recent chunk = live; connected but stale = reconnecting;
  // not connected = reconnecting (the manager loops with backoff).
  let sse: StageStatus;
  if (internet !== "live") {
    sse = "unknown";
  } else if (!sseConnected.value) {
    sse = "reconnecting";
  } else if (sseStale) {
    sse = "reconnecting";
  } else if (sseFresh || !haveSuccess) {
    // `!haveSuccess` covers the brief window between TCP-connected and
    // first chunk — render live so we don't blink orange on every load.
    sse = "live";
  } else {
    sse = "reconnecting";
  }

  let daemon: StageStatus;
  if (sse !== "live") {
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
    sse: {
      status: sse,
      label: "SSE",
      tooltip: sseTooltip(sse, sseFresh, sseStale, haveSuccess),
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

function sseTooltip(
  s: StageStatus,
  fresh: boolean,
  stale: boolean,
  haveSuccess: boolean,
): string {
  if (s === "unknown") return "SSE — waiting on internet";
  if (s === "live") {
    return fresh
      ? "SSE — connected; last frame under 30s ago"
      : "SSE — connected";
  }
  if (s === "down") return "SSE — disconnected";
  // reconnecting
  if (stale) return "SSE — no frame in 60+ seconds; reconnecting";
  if (!haveSuccess) return "SSE — connecting";
  return "SSE — reconnecting";
}

function daemonTooltip(s: StageStatus, uptimeMs: number | null): string {
  if (s === "unknown") return "Daemon — waiting on SSE";
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
