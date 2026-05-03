import {
  insertThreadConnection,
  deleteThreadConnection,
  getThreadConnectionByAgent,
  getThreadConnectionByThread,
  updateThreadActivity,
  getAllThreadConnections,
} from "@friday/shared";
import { log } from "../log.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface PendingReaction {
  channelId: string;
  messageTs: string;
  emojiName: string;
}

export interface ThreadConnection {
  agentName: string;
  channelId: string;
  threadTs: string;
  lastActivityAt: Date;
  idleTimer: ReturnType<typeof setTimeout>;
  pendingReaction?: PendingReaction;
}

export type DisconnectReason = "idle_timeout" | "manual" | "stolen";

export interface DisconnectResult {
  agentName: string;
  channelId: string;
  threadTs: string;
}

export type ConnectResult =
  | { ok: true; stolen?: DisconnectResult }
  | { ok: false; error: string };

// ── In-memory state ───────────────────────────────────────────────────────

const byAgent = new Map<string, ThreadConnection>();
const byThread = new Map<string, string>(); // threadTs → agentName

const IDLE_TIMEOUT_MS = 7_200_000; // 2 hours

let _onIdleDisconnect: ((conn: DisconnectResult) => void) | null = null;

// ── Internal helpers ──────────────────────────────────────────────────────

function startIdleTimer(agentName: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const conn = byAgent.get(agentName);
    if (!conn) return;

    const result = disconnectInternal(agentName);
    if (result && _onIdleDisconnect) {
      _onIdleDisconnect(result);
    }
    log("info", "thread_idle_disconnect", { agentName });
  }, IDLE_TIMEOUT_MS);
}

function disconnectInternal(agentName: string): DisconnectResult | null {
  const conn = byAgent.get(agentName);
  if (!conn) return null;

  clearTimeout(conn.idleTimer);
  byAgent.delete(agentName);
  byThread.delete(conn.threadTs);
  deleteThreadConnection(agentName);

  return {
    agentName: conn.agentName,
    channelId: conn.channelId,
    threadTs: conn.threadTs,
  };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Connect an agent to a Slack thread. Enforces 0-or-1 constraints:
 * - If the agent is already connected to a different thread, that connection
 *   is severed first (stolen path) and returned in result.stolen.
 * - If the thread is already connected to a different agent, returns an error.
 */
export function connect(
  agentName: string,
  channelId: string,
  threadTs: string
): ConnectResult {
  // Check if thread is already owned by a different agent
  const existingAgentForThread = byThread.get(threadTs);
  if (existingAgentForThread && existingAgentForThread !== agentName) {
    return {
      ok: false,
      error: `Thread is already connected to agent "${existingAgentForThread}". Disconnect it first.`,
    };
  }

  // If agent already has a connection to a different thread, steal it
  let stolen: DisconnectResult | undefined;
  const existingConnForAgent = byAgent.get(agentName);
  if (existingConnForAgent && existingConnForAgent.threadTs !== threadTs) {
    const result = disconnectInternal(agentName);
    if (result) stolen = result;
  }

  const now = Date.now();
  const idleTimer = startIdleTimer(agentName);

  const conn: ThreadConnection = {
    agentName,
    channelId,
    threadTs,
    lastActivityAt: new Date(now),
    idleTimer,
  };

  byAgent.set(agentName, conn);
  byThread.set(threadTs, agentName);

  insertThreadConnection({
    agentName,
    channelId,
    threadTs,
    lastActivityAt: now,
    createdAt: now,
  });

  log("info", "thread_connected", { agentName, channelId, threadTs, stolen: !!stolen });

  return { ok: true, ...(stolen ? { stolen } : {}) };
}

/**
 * Disconnect an agent from its thread. Returns connection info so the
 * caller can post a Slack message and remove the :link: reaction.
 */
export function disconnect(
  agentName: string,
  _reason: DisconnectReason
): DisconnectResult | null {
  return disconnectInternal(agentName);
}

export function getByAgent(agentName: string): ThreadConnection | undefined {
  return byAgent.get(agentName);
}

export function getByThread(threadTs: string): ThreadConnection | undefined {
  const agentName = byThread.get(threadTs);
  if (!agentName) return undefined;
  return byAgent.get(agentName);
}

/**
 * Reset the idle timer and update last_activity_at in SQLite.
 */
export function touchActivity(agentName: string): void {
  const conn = byAgent.get(agentName);
  if (!conn) return;

  clearTimeout(conn.idleTimer);
  conn.idleTimer = startIdleTimer(agentName);
  conn.lastActivityAt = new Date();
  updateThreadActivity(agentName, conn.lastActivityAt.getTime());
}

/**
 * Record that a processing emoji was added to the user's message while waiting
 * for the connected agent to respond. Cleared by clearPendingReaction().
 */
export function setPendingReaction(
  agentName: string,
  channelId: string,
  messageTs: string,
  emojiName: string
): void {
  const conn = byAgent.get(agentName);
  if (!conn) return;
  conn.pendingReaction = { channelId, messageTs, emojiName };
}

/**
 * Retrieve and clear the pending reaction for an agent. Returns undefined if
 * no reaction was pending (e.g., already cleared or agent not connected).
 */
export function clearPendingReaction(agentName: string): PendingReaction | undefined {
  const conn = byAgent.get(agentName);
  if (!conn) return undefined;
  const pending = conn.pendingReaction;
  conn.pendingReaction = undefined;
  return pending;
}

/**
 * Called at daemon startup. Reads all rows from SQLite, prunes expired
 * connections (> 2h since last activity) silently, and rebuilds in-memory
 * maps with live connections, restarting idle timers.
 */
export function initThreadRegistry(opts: {
  onIdleDisconnect: (conn: DisconnectResult) => void;
}): void {
  _onIdleDisconnect = opts.onIdleDisconnect;

  // Clear existing in-memory state before rebuilding from DB.
  // This ensures a clean slate whether called at startup or in tests.
  for (const conn of byAgent.values()) clearTimeout(conn.idleTimer);
  byAgent.clear();
  byThread.clear();

  const rows = getAllThreadConnections();
  const now = Date.now();
  let restored = 0;
  let pruned = 0;

  for (const row of rows) {
    const age = now - row.lastActivityAt;

    if (age >= IDLE_TIMEOUT_MS) {
      // Expired — prune silently (session is gone, no reaction removal)
      deleteThreadConnection(row.agentName);
      pruned++;
      continue;
    }

    // Live — rebuild in-memory state and restart timer with remaining time
    const remaining = IDLE_TIMEOUT_MS - age;
    const idleTimer = setTimeout(() => {
      const result = disconnectInternal(row.agentName);
      if (result && _onIdleDisconnect) {
        _onIdleDisconnect(result);
      }
      log("info", "thread_idle_disconnect", { agentName: row.agentName });
    }, remaining);

    const conn: ThreadConnection = {
      agentName: row.agentName,
      channelId: row.channelId,
      threadTs: row.threadTs,
      lastActivityAt: new Date(row.lastActivityAt),
      idleTimer,
    };

    byAgent.set(row.agentName, conn);
    byThread.set(row.threadTs, row.agentName);
    restored++;
  }

  log("info", "thread_registry_init", { restored, pruned });
}
