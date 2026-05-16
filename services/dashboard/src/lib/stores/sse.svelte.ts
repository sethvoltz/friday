import type { WireEvent } from "@friday/shared";
import { chat } from "./chat.svelte";
import { connectivity } from "./connectivity.svelte";
import { bumpDashboardData } from "./dashboard-data.svelte";
import { loadString, saveJSON, saveString } from "./persistent";

/**
 * SSE client (FIX_FORWARD 3.1). Backed by `fetch` + `response.body.getReader()`
 * with a manual SSE parser instead of the browser's `EventSource`:
 *
 *   - We own the lifecycle. `AbortController` tears down a connection
 *     instantly on tab visibility loss / `online` change / `stopSSE()`,
 *     instead of waiting for the browser's opaque reconnect timer.
 *   - `Last-Event-ID` is set explicitly on each fetch so resumption
 *     after a daemon-side restart is deterministic.
 *   - No background "auto-reconnect with fixed 3s interval" surprise:
 *     reconnection is governed entirely by our backoff schedule.
 *
 * Connection lifecycle:
 *   1. `startSSE` arms one connection; on visibility/online it forces
 *      a reconnect.
 *   2. Each connection runs until its reader closes or its abort
 *      controller fires. On close we schedule the next reconnect via
 *      backoff (initial 1s, doubling to 30s, ±25% jitter).
 *   3. The `connectionId` counter fences stale handlers — events read
 *      from an abandoned connection don't apply to the current one.
 */

const DASHBOARD_BUMP_TYPES = new Set([
  "turn_done",
  "agent_lifecycle",
  "agent_status",
  "schedule_fired",
]);

const HANDLED_TYPES = new Set([
  "turn_started",
  "error",
  "turn_done",
  "agent_message",
  "agent_lifecycle",
  "agent_status",
  "mail_delivered",
  "schedule_fired",
  "evolve_critical",
  "system_banner",
  "block_start",
  "block_delta",
  "block_complete",
  "block_canceled",
  "block_meta_update",
  "block_reload",
  "connection_established",
]);

// Keepalive watchdog (FIX_FORWARD 3.3). Daemon writes `:keepalive` every
// 20s (`cfg.sseKeepaliveSec`). If we go 40s with no bytes at all from the
// connection (2 missed keepalives), declare it dead and force a reconnect
// — the underlying TCP connection has stalled in a way the OS hasn't yet
// surfaced.
const KEEPALIVE_DEAD_AFTER_MS = 40_000;
const KEEPALIVE_CHECK_INTERVAL_MS = 5_000;

// Reconnect schedule (FIX_FORWARD 3.2). Two ladders:
//   - Fresh page load: cold start, the user just opened the tab and
//     expects quick liveness. Try immediately, then escalate gently.
//   - Mid-session disconnect: an established connection dropped.
//     Backoff a touch longer up front to avoid hammering a daemon that
//     just bounced.
// Both cap at 10s and stay there indefinitely — no max retry count.
// ±20% jitter per attempt smooths thundering-herd on daemon reboot.
const FRESH_LOAD_LADDER_MS = [0, 250, 500, 1000, 2000, 5000, 10_000];
const MID_SESSION_LADDER_MS = [500, 1000, 2000, 5000, 10_000];
const RECONNECT_CAP_MS = 10_000;
const RECONNECT_JITTER = 0.2;

class SseConnected {
  value = $state(false);
}
export const sseConnected = new SseConnected();

let abortController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
/** True until the first time a connection lands. Drives the cold-start
 *  ladder (FIX_FORWARD 3.2). Flipped to false on first successful
 *  `connection_established` so subsequent drops use the mid-session
 *  ladder. */
let freshLoad = true;
/** Count of reconnect attempts since the last successful connection.
 *  Indexes into the active ladder; past the end we hold at the cap. */
let attempt = 0;
let visListener: (() => void) | null = null;
let onlineListener: (() => void) | null = null;
/** Monotonic counter incremented on every `connect()`. Captured in the
 *  closure of each fetch's reader loop so a stale chunk arriving on an
 *  abandoned connection can't apply events to the current one. */
let connectionId = 0;
/** Last `id:` field we saw on the wire. Sent as `Last-Event-ID` on the
 *  next reconnect so the daemon resumes from `replaySince(lastEventId)`. */
let lastEventId: string | null = null;
/** localStorage key for the last daemon boot_id we connected to. Hydrated
 *  at module load so a fresh page load can detect a daemon restart on the
 *  very first `connection_established` event — without this, the
 *  module-scoped `cachedBootId` would start `null` on every reload, the
 *  mismatch check below would short-circuit, and the persisted
 *  `chat.lastSeqByAgent` cursor (FIX_FORWARD 3-C) from the previous daemon
 *  would silently reject every event from the new daemon (whose `seq`
 *  counter restarted at 0). FRI-8 regression. */
const BOOT_ID_KEY = "sse:bootId";

/** Cached daemon boot_id from the most recent `connection_established`.
 *  Hydrated from localStorage so we detect daemon restarts that happened
 *  while no tab was open. Persisted again whenever we learn a fresh
 *  boot_id. On mismatch we drop the per-agent cursors and refetch the
 *  focused agent's history. */
let cachedBootId: string | null = loadString(BOOT_ID_KEY);

async function connect(): Promise<void> {
  if (abortController) return;
  if (stopped) return;
  const myId = ++connectionId;
  const ctrl = new AbortController();
  abortController = ctrl;
  try {
    const headers: HeadersInit = {
      accept: "text/event-stream",
    };
    if (lastEventId !== null) headers["last-event-id"] = lastEventId;
    const res = await fetch("/api/events", {
      headers,
      signal: ctrl.signal,
      // Defensive: SSE responses must NOT be cached by intermediaries; the
      // daemon already sets `cache-control: no-cache`, but be belt-and-braces.
      cache: "no-store",
    });
    if (myId !== connectionId) return;
    if (!res.ok || !res.body) {
      throw new Error(`/api/events returned ${res.status}`);
    }
    sseConnected.value = true;
    chat.connected = true;
    // Successful connection — reset the ladder cursor and graduate
    // from the cold-start schedule (FIX_FORWARD 3.2).
    attempt = 0;
    freshLoad = false;

    await readEvents(res.body, myId, ctrl);
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") return;
    // Surface only — the finally block schedules the retry.
  } finally {
    if (myId === connectionId) {
      sseConnected.value = false;
      chat.connected = false;
      if (abortController === ctrl) abortController = null;
      if (!stopped) scheduleReconnect();
    }
  }
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  myId: number,
  ctrl: AbortController,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  // Keepalive watchdog timestamp — every chunk (including `:keepalive`
  // comments) updates this. The interval below aborts the connection if
  // we go silent for too long.
  let lastChunkAt = Date.now();
  const watchdog = setInterval(() => {
    if (myId !== connectionId) return;
    if (Date.now() - lastChunkAt > KEEPALIVE_DEAD_AFTER_MS) {
      // Force the fetch + reader loop to unwind so the finally block
      // schedules the next reconnect via the normal ladder.
      ctrl.abort();
    }
  }, KEEPALIVE_CHECK_INTERVAL_MS);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (myId !== connectionId) {
        ctrl.abort();
        break;
      }
      lastChunkAt = Date.now();
      // Every chunk (including `:keepalive`) is proof the client → daemon
      // path is live (FIX_FORWARD 3.10 stage 1).
      connectivity.markSuccess();
      buf += decoder.decode(value, { stream: true });
      // SSE event terminator is a blank line (\n\n or \r\n\r\n). Split on
      // both — some intermediaries normalize line endings.
      while (true) {
        const sep = buf.search(/\r?\n\r?\n/);
        if (sep < 0) break;
        const block = buf.slice(0, sep);
        const skip = buf.slice(sep).match(/^\r?\n\r?\n/)![0].length;
        buf = buf.slice(sep + skip);
        const parsed = parseEvent(block);
        if (parsed) handleEvent(parsed, myId);
      }
    }
  } finally {
    clearInterval(watchdog);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

interface ParsedEvent {
  id?: string;
  event?: string;
  data: string;
}

function parseEvent(block: string): ParsedEvent | null {
  const lines = block.split(/\r?\n/);
  const dataParts: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  for (const raw of lines) {
    if (!raw || raw.startsWith(":")) continue; // empty / comment
    const colon = raw.indexOf(":");
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") dataParts.push(value);
  }
  if (dataParts.length === 0 && event === undefined && id === undefined)
    return null;
  return { id, event, data: dataParts.join("\n") };
}

/**
 * Reconcile a freshly-arrived `connection_established` against the
 * cached/persisted boot_id. On mismatch the daemon is a different process
 * than the one that produced the persisted `chat.lastSeqByAgent` cursor
 * — its ring buffer started from `seq=0`, so the persisted cursor would
 * silently reject every new event. Clear it, drop the persisted copy,
 * and re-seed the focused agent's history from the canonical blocks
 * endpoint.
 *
 * Exported so the FRI-8 regression test can drive it without standing
 * up a real fetch + SSE reader loop.
 */
export function acceptConnectionEstablished(
  incomingBootId: string,
  bootTs: number,
): void {
  if (cachedBootId !== null && cachedBootId !== incomingBootId) {
    chat.lastSeqByAgent = {};
    saveJSON("chat:lastSeqByAgent", {});
    void chat.loadAgentTurns(chat.focusedAgent);
  }
  cachedBootId = incomingBootId;
  saveString(BOOT_ID_KEY, incomingBootId);
  chat.bootId = incomingBootId;
  chat.bootTs = bootTs;
}

function handleEvent(evt: ParsedEvent, myId: number): void {
  if (myId !== connectionId) return;
  // Update Last-Event-ID cursor (used on the next reconnect's headers).
  // `connection_established` deliberately skips `id:` so the cursor only
  // ever advances to real bus seqs.
  if (evt.id !== undefined && evt.id !== "") lastEventId = evt.id;

  const type = evt.event ?? "";
  if (!HANDLED_TYPES.has(type)) return;
  let parsed: WireEvent;
  try {
    parsed = JSON.parse(evt.data) as WireEvent;
  } catch {
    return;
  }
  if (parsed.type === "connection_established") {
    acceptConnectionEstablished(parsed.boot_id, parsed.boot_ts);
    return;
  }
  chat.applyEvent(parsed);
  if (DASHBOARD_BUMP_TYPES.has(type)) bumpDashboardData();
}

function nextBackoffMs(): number {
  const ladder = freshLoad ? FRESH_LOAD_LADDER_MS : MID_SESSION_LADDER_MS;
  const base = attempt >= ladder.length ? RECONNECT_CAP_MS : ladder[attempt];
  attempt += 1;
  if (base === 0) return 0;
  // ±20% jitter (FIX_FORWARD 3.2).
  const span = base * RECONNECT_JITTER;
  return Math.max(0, base + (Math.random() * 2 - 1) * span);
}

function scheduleReconnect(): void {
  if (reconnectTimer || stopped) return;
  const delay = nextBackoffMs();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

/** Drop any pending backoff and reconnect immediately. Called on
 *  `visibilitychange → visible` and `online` events — strong hints that
 *  whatever broke the previous connection is fixed. */
function reconnectNow(): void {
  if (stopped) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (abortController) return; // already connecting / connected
  attempt = 0;
  void connect();
}

export function startSSE(): void {
  if (abortController || reconnectTimer) return;
  stopped = false;
  freshLoad = true;
  attempt = 0;
  void connect();
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
  abortController?.abort();
  abortController = null;
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
