import type { WireEvent } from "@friday/shared";
import { chat } from "./chat.svelte";
import { bumpDashboardData } from "./dashboard-data.svelte";

const DASHBOARD_BUMP_TYPES = new Set([
  "turn_done",
  "agent_lifecycle",
  "agent_status",
  "schedule_fired",
]);

let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 0;
let visListener: (() => void) | null = null;
let onlineListener: (() => void) | null = null;
let stopped = false;

const BACKOFF_INITIAL = 1000;
const BACKOFF_MAX = 30_000;

class SseConnected {
  value = $state(false);
}
export const sseConnected = new SseConnected();

const HANDLED_TYPES = new Set([
  "turn_started",
  "text_delta",
  "tool_use_start",
  "tool_use_input",
  "tool_use_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "compaction_start",
  "compaction_end",
  "error",
  "turn_done",
  "agent_message",
  "agent_lifecycle",
  "agent_status",
  "mail_delivered",
  "schedule_fired",
  "evolve_critical",
  "system_banner",
]);

/**
 * Open the EventSource. The browser auto-attaches `Last-Event-ID` based on the
 * last `id:` line we received, so a clean reconnect resumes from the daemon's
 * `eventBus.replaySince()` cursor without us tracking it manually. The chat
 * store's `applyEvent` is idempotent on `seq`, so a daemon restart that resets
 * the bus counter still converges (the first replayed event's seq will be
 * lower than our client cursor, but `applyEvent` ignores duplicates by id).
 */
function connect(): void {
  if (es) return;
  if (stopped) return;
  es = new EventSource("/api/events");
  es.onopen = () => {
    sseConnected.value = true;
    chat.connected = true;
    backoffMs = 0;
    // Daemon restart resets its seq counter to small values; without a reset
    // here, our (stale, high) lastSeq would filter every new event out.
    chat.lastSeq = 0;
  };
  es.onerror = () => {
    sseConnected.value = false;
    chat.connected = false;
    // EventSource's built-in reconnect uses a fixed ~3s interval and doesn't
    // back off, so a daemon that's down for a while produces a request flood.
    // Manage reconnection ourselves with exponential backoff capped at 30s.
    es?.close();
    es = null;
    scheduleReconnect();
  };
  for (const t of HANDLED_TYPES) {
    es.addEventListener(t, (e: MessageEvent) => {
      try {
        chat.applyEvent(JSON.parse(e.data) as WireEvent);
      } catch {
        /* ignore */
      }
      if (DASHBOARD_BUMP_TYPES.has(t)) bumpDashboardData();
    });
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || stopped) return;
  backoffMs =
    backoffMs === 0
      ? BACKOFF_INITIAL
      : Math.min(backoffMs * 2, BACKOFF_MAX);
  // Jitter: ±25% so we don't thundering-herd a daemon coming back up.
  const jitter = backoffMs * (0.75 + Math.random() * 0.5);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, jitter);
}

/** Force an immediate reconnect attempt (drop any pending backoff). Called
 *  when the page becomes visible or the network reports back online — both
 *  are strong hints that whatever broke the previous connection is fixed. */
function reconnectNow(): void {
  if (stopped) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (es) return; // already connected (or trying)
  backoffMs = 0;
  connect();
}

export function startSSE(): void {
  if (es || reconnectTimer) return;
  stopped = false;
  connect();
  if (typeof document !== "undefined" && !visListener) {
    visListener = () => {
      if (document.visibilityState === "visible" && !sseConnected.value) {
        reconnectNow();
      }
    };
    document.addEventListener("visibilitychange", visListener);
  }
  if (typeof window !== "undefined" && !onlineListener) {
    onlineListener = () => reconnectNow();
    window.addEventListener("online", onlineListener);
  }
}

export function stopSSE(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  es?.close();
  es = null;
  sseConnected.value = false;
  if (visListener && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", visListener);
    visListener = null;
  }
  if (onlineListener && typeof window !== "undefined") {
    window.removeEventListener("online", onlineListener);
    onlineListener = null;
  }
}
