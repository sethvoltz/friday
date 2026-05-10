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
/** Monotonic counter incremented on every `connect()`. Captured in the
 *  closure of each EventSource's handlers so a stale `onerror` from a
 *  previous, abandoned connection can't null out a freshly-opened one
 *  (or apply events to it that the new connection should be receiving). */
let connectionId = 0;

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
  // Mint a new connection id; every handler closes over `myId` and ignores
  // its event if the global cursor has moved on (the connection was
  // replaced). Without this, a stale onerror firing after a reconnect
  // would null out the *new* EventSource.
  const myId = ++connectionId;
  // Whether we've ever seen a `seq` from this specific connection. Used to
  // detect a daemon restart on the FIRST event we receive: if the daemon's
  // counter has rolled back below our cached `chat.lastSeq`, the daemon
  // restarted its bus and we need to reset our cursor. A transient network
  // blip without a daemon restart leaves the seq monotonically higher and
  // we keep the cursor — preventing duplicate `applyEvent` for events
  // that already had effect.
  let firstSeqSeen = false;
  const ev = new EventSource("/api/events");
  es = ev;
  ev.onopen = () => {
    if (myId !== connectionId) return;
    sseConnected.value = true;
    chat.connected = true;
    backoffMs = 0;
  };
  ev.onerror = () => {
    if (myId !== connectionId) return; // stale handler — ignore.
    sseConnected.value = false;
    chat.connected = false;
    // EventSource's built-in reconnect uses a fixed ~3s interval and doesn't
    // back off, so a daemon that's down for a while produces a request flood.
    // Manage reconnection ourselves with exponential backoff capped at 30s.
    ev.close();
    if (es === ev) es = null;
    scheduleReconnect();
  };
  for (const t of HANDLED_TYPES) {
    ev.addEventListener(t, (e: MessageEvent) => {
      if (myId !== connectionId) return;
      try {
        const parsed = JSON.parse(e.data) as WireEvent;
        if (!firstSeqSeen) {
          firstSeqSeen = true;
          // Daemon restart? If the first seq from a fresh connection is
          // *lower* than our cached cursor, the daemon's bus counter has
          // rolled back; reset our cursor so we accept the replay. If
          // it's higher (the normal blip-and-reconnect case), keep the
          // cursor and let `applyEvent`'s seq check drop already-applied
          // events.
          if (typeof parsed.seq === "number" && parsed.seq < chat.lastSeq) {
            chat.lastSeq = 0;
          }
        }
        chat.applyEvent(parsed);
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
