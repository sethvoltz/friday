import type { WireEvent } from "@friday/shared";
import { fetchWithTimeout } from "../util/fetch-with-timeout";
import { initialPageSize } from "../util/page-size";
import { KEYS, loadJSON, saveJSON } from "./persistent";
import { sendQueue } from "./send-queue.svelte";

export interface ChatMessage {
  /** turn_id for assistant; "u_<n>" for user; "t_<toolId>"; "th_<blockId>". */
  id: string;
  role: "user" | "assistant" | "tool" | "thinking";
  /** user/assistant: rendered markdown body. thinking: streamed thoughts. tool: unused. */
  text: string;
  status:
    | "streaming" // assistant turn still receiving deltas
    | "complete"
    | "aborted"
    | "error"
    | "running" // tool/thinking still in progress
    | "done";
  agent?: string;
  ts: number;

  // Assistant-specific: the turn this bubble belongs to. Recorded on
  // appendDelta so finishTurn can match bubbles whose primary id is keyed
  // by the SDK message_id rather than the turn_id.
  turnId?: string;

  // Tool-specific
  toolId?: string;
  toolName?: string;
  input?: unknown;
  output?: string;

  // Thinking-specific
  blockId?: string;

  /** Source DB row id for the JSONL turn this message was parsed from.
   * Used as the pagination cursor when loading older history. Live SSE
   * deltas don't carry one. */
  dbTurnId?: number;

  /** Optimistic-send queue id. When set, this user bubble represents a
   * message that is waiting to flush — render with a "queued" pill so the
   * user can see it didn't actually reach the daemon yet. Cleared as soon
   * as the queue successfully POSTs the message. */
  queueId?: string;

  /** Attachments included on the user message (rendered inline as chips
   * for non-images, thumbnails for images). */
  attachments?: Array<{ sha256: string; filename: string; mime: string }>;

  /** Where the bubble originated. Carries through to the canonical block
   *  (matches the `source` column in the blocks table). FIX_FORWARD 2.6. */
  source?: "user_chat" | "mail" | "queue_inject" | "sdk";

  /** True from the moment a user types until `/api/chat/turn` confirms
   *  the dispatch with `{turn_id}`. Pending bubbles render pinned to the
   *  bottom regardless of natural ts sort (FIX_FORWARD 2.6). */
  pending?: boolean;

  /** Set when the send-queue's flush returned a 4xx — surface a
   *  retry/discard affordance (FIX_FORWARD 2.6). */
  failed?: boolean;

  /** Set when the send-queue's flush returned a 5xx / network error and
   *  the queue is scheduling a backoff retry (FIX_FORWARD 2.6). */
  retrying?: boolean;
}

export interface AgentInfo {
  name: string;
  type: string;
  status: string;
  /** Current SDK session id, when one is active. Used to distinguish
   * "current chat" from "past sessions" in the sidebar's expand-history view. */
  sessionId?: string;
  /** Distinct session count, populated by /api/agents. Indicates whether
   * the sidebar should show an expand-history button for this agent. */
  sessionCount?: number;
}

/** Sentinel agent bucket for SSE events that don't carry an `agent` field
 *  (system_banner, mail_delivered, schedule_fired, evolve_critical). */
export const SYSTEM_BUCKET = "__system__";

/**
 * Stable bubble id for a user-role chat message keyed by its turn_id. Used
 * both client-side (when `/api/chat/turn` confirms a dispatch) and on the
 * SSE handler (when the daemon emits the canonical `block_complete` for the
 * user-role block) so the two paths converge on the same ChatMessage row.
 * FIX_FORWARD 2.6.
 */
export function userBlockIdForTurn(turnId: string): string {
  return `user_${turnId}`;
}

export class ChatState {
  messages = $state<ChatMessage[]>([]);
  agents = $state<AgentInfo[]>([]);
  focusedAgent = $state("friday");
  /**
   * Per-agent cursor for race-free SSE catchup (FIX_FORWARD 1.7). Keyed by
   * `event.agent`, plus the `__system__` bucket for events that don't carry
   * one. Dedup compares `event.seq` against the bucket's current value; a
   * fresh value is written after each event is applied.
   */
  lastSeqByAgent = $state<Record<string, number>>({});
  /** Cached daemon boot_id from connection_established (FIX_FORWARD 1.6). */
  bootId = $state<string | null>(null);
  /** Daemon boot timestamp (unix ms) from connection_established. Drives
   *  the connectivity widget's uptime tail (FIX_FORWARD 3.10). */
  bootTs = $state<number | null>(null);
  inflightTurnId = $state<string | null>(null);
  connected = $state(false);
  /** Per-agent unread badge counts (FIX_FORWARD 3.6). Bumped by SSE
   *  `agent_message` events while another agent is focused; cleared when
   *  the user focuses the agent. */
  unreadByAgent = $state<Record<string, number>>({});
  /** Transient toast surfaced by client-side commands (FIX_FORWARD 6.1).
   *  `null` when no toast is active. ChatShell mounts a floating pill. */
  toast = $state<{ message: string; level: "info" | "warn" } | null>(null);
  /** Bubble id to highlight after a `/jump` (FIX_FORWARD 6.1). The
   *  matching ChatMessage element scrolls into view and pulses briefly. */
  highlightedMessageId = $state<string | null>(null);
  /** Smallest `dbTurnId` we've loaded; pagination cursor for older turns. */
  oldestDbId = $state<number | null>(null);
  /** True while a paginated fetch is in flight; prevents re-entrant calls. */
  loadingOlder = $state(false);
  /** True once we've fetched and gotten back an empty page (no more history). */
  reachedOldest = $state(false);
  /** True while the initial fetch for the focused agent is in flight and we
   *  have nothing (cached or otherwise) to show. Drives the skeleton state
   *  in ChatMessages so a slow first paint isn't a blank page. */
  loadingInitial = $state(false);
  /** Set when the initial history fetch fails with no cached fallback to
   * paper over it. ChatMessages renders this as a banner with a Retry
   * button — distinguishes "actually empty" from "couldn't reach daemon". */
  historyError = $state<string | null>(null);
  /** Set by ChatShell from its scroll handler. ChatMessages reads it to
   * decide whether to slice the rendered list (cap at WINDOW when bottom-
   * pinned) or render everything (when the user is reading older history). */
  pinnedToBottom = $state(true);

  /** Per-agent debounce timers for working→idle transitions. Long-lived
   * workers emit `status-change: idle` between back-to-back turns
   * (worker.ts waits for the next prompt in an idle loop), which would
   * otherwise flicker the sidebar dot grey for a fraction of a second.
   * If a fresh `working` arrives before the timer fires, the idle is
   * cancelled and the dot stays green. */
  private idleDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly IDLE_DEBOUNCE_MS = 750;

  /** Insert or refresh a local AgentInfo entry. Used when SSE events arrive
   * for an agent the 5s `/api/agents` poll hasn't reported yet (newly
   * spawned). The next poll fills in details we don't know here. */
  upsertAgent(
    name: string,
    patch: Partial<Omit<AgentInfo, "name">>,
  ): void {
    const i = this.agents.findIndex((a) => a.name === name);
    if (i === -1) {
      this.agents.push({
        name,
        type: patch.type ?? "unknown",
        status: patch.status ?? "idle",
        sessionId: patch.sessionId,
        sessionCount: patch.sessionCount,
      });
      return;
    }
    const cur = this.agents[i];
    this.agents[i] = { ...cur, ...patch };
  }

  /** Drop an agent from the sidebar list. Called on
   *  `agent_lifecycle: kill` (FIX_FORWARD 3.6). */
  removeAgent(name: string): void {
    this.agents = this.agents.filter((a) => a.name !== name);
    delete this.unreadByAgent[name];
  }

  /** Increment the unread badge for an agent (FIX_FORWARD 3.6). */
  bumpUnread(agent: string): void {
    this.unreadByAgent[agent] = (this.unreadByAgent[agent] ?? 0) + 1;
  }

  /** Clear the unread badge for an agent — called by the sidebar when
   *  the user focuses it (FIX_FORWARD 3.6). */
  clearUnread(agent: string): void {
    if (agent in this.unreadByAgent) delete this.unreadByAgent[agent];
  }

  /** Apply an agent_status event with a debounce on working→idle so brief
   * inter-turn idle pulses don't flicker the dot. Working transitions and
   * non-binary states (stalled/error/killed) apply immediately. */
  private applyAgentStatus(name: string, status: string): void {
    const existing = this.agents.find((a) => a.name === name);
    const prev = existing?.status;

    if (status === "idle" && prev === "working") {
      const t = setTimeout(() => {
        this.idleDebounce.delete(name);
        this.upsertAgent(name, { status });
      }, ChatState.IDLE_DEBOUNCE_MS);
      this.idleDebounce.set(name, t);
      return;
    }

    const pending = this.idleDebounce.get(name);
    if (pending) {
      clearTimeout(pending);
      this.idleDebounce.delete(name);
    }
    this.upsertAgent(name, { status });
  }

  addUser(
    text: string,
    opts?: {
      queueId?: string;
      attachments?: Array<{ sha256: string; filename: string; mime: string }>;
    },
  ): string {
    // FIX_FORWARD 2.6: mint a `pending_<uuid>` id and `pending: true` so
    // the bubble pins to the bottom of the chat until the dispatch lands.
    // `confirmPending` re-keys to the daemon-issued turn_id once
    // /api/chat/turn returns; the canonical user-role block carries the
    // same id and overwrites this entry in-place.
    const id = `pending_${
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? (crypto as { randomUUID: () => string }).randomUUID()
        : `${Date.now()}_${Math.random().toString(36).slice(2)}`
    }`;
    this.messages.push({
      id,
      role: "user",
      text,
      status: "complete",
      ts: Date.now(),
      source: "user_chat",
      pending: true,
      queueId: opts?.queueId,
      attachments: opts?.attachments,
    });
    return id;
  }

  /** Clear `queueId` from the user bubble matching this queue id, if any.
   *  Called when the send-queue successfully flushes a previously queued
   *  message — the bubble is no longer "queued", just sent. */
  clearQueueMarker(queueId: string): void {
    for (const m of this.messages) {
      if (m.queueId === queueId) m.queueId = undefined;
    }
  }

  /**
   * The pending user bubble (matched by `queueId`) has been confirmed by
   * `/api/chat/turn` returning `{turn_id}` (FIX_FORWARD 2.6). Re-key the
   * bubble id to the daemon-issued user-block id (mirroring the canonical
   * block id daemon's `recordUserBlock` will emit on the SSE stream), drop
   * `pending`, drop transient send-queue state. Natural sort restores; the
   * eventual `block_complete` SSE event finds the same id and is a no-op.
   */
  confirmPending(queueId: string, turnId: string): void {
    for (const m of this.messages) {
      if (m.queueId !== queueId) continue;
      m.id = userBlockIdForTurn(turnId);
      m.turnId = turnId;
      m.pending = false;
      m.failed = false;
      m.retrying = false;
      m.queueId = undefined;
      return;
    }
  }

  /** Mark the pending bubble for this queueId as failed (4xx) so the UI
   *  surfaces retry/discard. FIX_FORWARD 2.6. */
  markPendingFailed(queueId: string): void {
    for (const m of this.messages) {
      if (m.queueId !== queueId) continue;
      m.failed = true;
      m.retrying = false;
      return;
    }
  }

  /** Mark the pending bubble for this queueId as retrying (5xx / network).
   *  FIX_FORWARD 2.6. */
  markPendingRetrying(queueId: string): void {
    for (const m of this.messages) {
      if (m.queueId !== queueId) continue;
      m.retrying = true;
      m.failed = false;
      return;
    }
  }

  /** Remove the pending bubble matching `queueId` (FIX_FORWARD 2.7 — used
   *  when the user picks "Discard and continue" or "Discard all"). */
  discardPending(queueId: string): void {
    this.messages = this.messages.filter((m) => m.queueId !== queueId);
  }

  /** Remove every pending bubble in one go (FIX_FORWARD 2.7 — "Discard all
   *  and continue"). */
  discardAllPending(): void {
    this.messages = this.messages.filter((m) => !m.pending);
  }

  /** Show a transient toast for `ms` (default 4000). FIX_FORWARD 6.1. */
  setToast(message: string, level: "info" | "warn" = "info", ms = 4000): void {
    this.toast = { message, level };
    setTimeout(() => {
      // Don't clobber a later toast that landed during the timeout.
      if (this.toast && this.toast.message === message) this.toast = null;
    }, ms);
  }

  /**
   * Implements `/jump <date|term>` (FIX_FORWARD 6.1).
   *
   * Tries to interpret `arg` as a date first (Date.parse + a few NL
   * keywords). On a finite parse, requests the `around_ts` window;
   * otherwise hits `match=` for FTS lookup. Replaces `messages` with
   * the returned block window and marks the first hit for highlight.
   * Surfaces a toast if no blocks come back.
   */
  async jumpTo(agent: string, arg: string): Promise<void> {
    const trimmed = arg.trim();
    if (!trimmed) {
      this.setToast("Usage: /jump <date|term>", "warn");
      return;
    }
    const ts = parseJumpDate(trimmed);
    const url =
      ts !== null
        ? `/api/agents/${encodeURIComponent(agent)}/blocks?around_ts=${ts}&before_limit=10&after_limit=40`
        : `/api/agents/${encodeURIComponent(agent)}/blocks?match=${encodeURIComponent(trimmed)}&limit=20`;
    try {
      const r = await fetch(url);
      if (!r.ok) {
        this.setToast("Couldn't search this chat.", "warn");
        return;
      }
      const data = (await r.json()) as { blocks: BlockRow[] };
      if (!data.blocks || data.blocks.length === 0) {
        this.setToast("No match in this chat.", "warn");
        return;
      }
      const parsed = parseBlocks(data.blocks, agent);
      this.messages = parsed;
      // First match: for `around_ts` that's the block at or just after
      // the target ts; for `match` that's the top-ranked hit (first
      // returned, then parseBlocks sorted by id asc so it's the oldest
      // in the result set). Either way, the first non-tool, non-
      // thinking bubble is what the user is looking for.
      const target = parsed.find(
        (m) => m.role === "user" || m.role === "assistant",
      );
      this.highlightedMessageId = target?.id ?? null;
    } catch (err) {
      this.setToast(
        err instanceof Error ? err.message : "Jump failed.",
        "warn",
      );
    }
  }

  startAssistantTurn(turnId: string, agent: string): void {
    this.inflightTurnId = turnId;
    this.messages.push({
      id: turnId,
      role: "assistant",
      text: "",
      status: "streaming",
      agent,
      ts: Date.now(),
    });
  }

  /**
   * Append a text delta to the in-flight assistant bubble.
   *
   * Bubble id is `assistant_<messageId>` when the SDK has provided a message
   * id (the normal case) — that matches the id `extractBlocks` synthesizes
   * for the same content when reading the canonical JSONL row from DB, so a
   * page refresh mid-stream lands on the same bubble instead of duplicating.
   *
   * Falls back to `<turnId>` on the very first delta before message_start
   * has fired (rare). When messageId arrives later, we still find the bubble
   * by the (turnId-shaped) id we created the first time and keep appending.
   *
   * Idempotent on already-finalized bubbles: if the SSE event is a replay of
   * a turn that's now complete in DB, no-op.
   */
  appendDelta(turnId: string, delta: string, messageId?: string): void {
    const id = messageId ? `assistant_${messageId}` : turnId;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role !== "assistant") continue;
      if (m.id === id || m.id === turnId) {
        if (
          m.status === "complete" ||
          m.status === "aborted" ||
          m.status === "error"
        ) {
          return;
        }
        m.text += delta;
        m.turnId = turnId;
        return;
      }
    }
    this.messages.push({
      id,
      role: "assistant",
      text: delta,
      status: "streaming",
      turnId,
      ts: Date.now(),
    });
  }

  finishTurn(
    turnId: string,
    status: "complete" | "aborted" | "error",
  ): void {
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      if (m.id === turnId || m.turnId === turnId) {
        if (
          m.status === "complete" ||
          m.status === "aborted" ||
          m.status === "error"
        ) {
          continue;
        }
        m.status = status;
      }
    }
    if (this.inflightTurnId === turnId) this.inflightTurnId = null;
  }

  pushTool(toolId: string, toolName: string, input: unknown): void {
    const id = `t_${toolId}`;
    if (this.messages.some((m) => m.id === id)) return;
    this.messages.push({
      id,
      role: "tool",
      text: "",
      status: "running",
      toolId,
      toolName,
      input,
      ts: Date.now(),
    });
  }

  /** Lazy-create: if the tool block hasn't been pushed yet (e.g. start was
   * evicted from the SSE ring), push it now. Idempotent on `done`/`error`. */
  setToolInput(toolId: string, input: unknown): void {
    const id = `t_${toolId}`;
    for (const m of this.messages) {
      if (m.id === id) {
        if (m.status === "done" || m.status === "error") return;
        m.input = input;
        return;
      }
    }
    this.messages.push({
      id,
      role: "tool",
      text: "",
      status: "running",
      toolId,
      input,
      ts: Date.now(),
    });
  }

  /** Lazy-create + idempotent: SSE replay shouldn't overwrite a tool block
   * already finalized from DB. */
  finishTool(toolId: string, status: "ok" | "error", output?: string): void {
    const id = `t_${toolId}`;
    for (const m of this.messages) {
      if (m.id === id) {
        if (m.status === "done" || m.status === "error") return;
        m.status = status === "ok" ? "done" : "error";
        if (output !== undefined) m.output = output;
        return;
      }
    }
    this.messages.push({
      id,
      role: "tool",
      text: "",
      status: status === "ok" ? "done" : "error",
      toolId,
      output,
      ts: Date.now(),
    });
  }

  pushThinking(blockId: string): void {
    const id = `th_${blockId}`;
    if (this.messages.some((m) => m.id === id)) return;
    this.messages.push({
      id,
      role: "thinking",
      text: "",
      status: "running",
      blockId,
      ts: Date.now(),
    });
  }

  /** Lazy-create + idempotent. Mirrors appendDelta semantics for thinking. */
  appendThinking(blockId: string, delta: string): void {
    const id = `th_${blockId}`;
    for (const m of this.messages) {
      if (m.id === id) {
        if (m.status === "done" || m.status === "error") return;
        m.text += delta;
        return;
      }
    }
    this.messages.push({
      id,
      role: "thinking",
      text: delta,
      status: "running",
      blockId,
      ts: Date.now(),
    });
  }

  finishThinking(blockId: string): void {
    const id = `th_${blockId}`;
    for (const m of this.messages) {
      if (m.id === id) {
        if (m.status === "done" || m.status === "error") return;
        m.status = "done";
        return;
      }
    }
    this.messages.push({
      id,
      role: "thinking",
      text: "",
      status: "done",
      blockId,
      ts: Date.now(),
    });
  }

  async loadAgentTurns(agent: string): Promise<void> {
    // Clear immediately so switching agents doesn't briefly show the prior
    // agent's messages while turns are fetching.
    this.messages = [];
    this.oldestDbId = null;
    this.reachedOldest = false;
    this.historyError = null;
    // Clear any stale loading-older flag from the previous agent. Without
    // this, if the user scrolled up in agent A and clicked away before
    // the load finished, A's `loadingOlder=true` would persist into B's
    // chat and block B's first pagination request until A's stale finally
    // fires (~350ms later). The new guards in `loadOlderTurns` ensure
    // that stale call won't clobber B's state.
    this.loadingOlder = false;

    // Last-known transcript from a previous session. Render the cached turns
    // immediately so a slow / offline first-paint doesn't show an empty
    // chat. The live fetch below replaces this once it lands; the bubble
    // ids are stable across cache → fresh, so any in-flight stream attaches
    // cleanly.
    const cached = loadJSON<TurnRow[]>(KEYS.transcript(agent), []);
    if (cached.length > 0) {
      this.messages = parseTurns(cached, agent);
      this.oldestDbId = oldestDbTurnId(cached);
    }

    // Synthesize user bubbles for any queued-but-not-yet-sent messages
    // belonging to this agent. Without this, a page reload while a
    // message is queued (offline / 5xx) hides the bubble — the message
    // is still in the queue and the layout-mount flush will try to send
    // it, but the user has no idea it exists. For `failed` entries the
    // bubble exposes the Retry/Remove affordances that would otherwise
    // be unreachable.
    for (const q of sendQueue.forAgent(agent)) {
      this.messages.push({
        id: `u_queue_${q.id}`,
        role: "user",
        text: q.text,
        status: "complete",
        ts: q.createdAt,
        queueId: q.id,
        attachments: q.attachments,
      });
    }

    this.loadingInitial = cached.length === 0;

    try {
      // FIX_FORWARD 3.8: client-picked initial page size based on viewport
      // + network class. Server clamps to ≤200 regardless.
      const limit = initialPageSize();
      const r = await fetchWithTimeout(
        `/api/agents/${agent}/turns?limit=${limit}`,
        { timeoutMs: 15_000 },
      );
      // The user may have switched agents while we were awaiting. Bail
      // before mutating shared state so a late-resolving fetch from a
      // prior agent doesn't overwrite the just-loaded current agent.
      if (this.focusedAgent !== agent) return;
      if (!r.ok) {
        if (cached.length === 0) {
          this.historyError = `Couldn't load history (HTTP ${r.status})`;
        }
        return;
      }
      const turns = (await r.json()) as TurnRow[];
      if (this.focusedAgent !== agent) return;
      this.messages = parseTurns(turns, agent);
      this.oldestDbId = oldestDbTurnId(turns);
      if (turns.length === 0) {
        this.reachedOldest = true;
      } else {
        // Trim before persisting: localStorage caps around 5MB per origin
        // and contentJson can carry sizable tool inputs/outputs. Cap at the
        // initial-page heuristic so the cached payload tracks first-paint.
        saveJSON(KEYS.transcript(agent), turns.slice(0, limit));
      }
    } catch {
      // Network/timeout. If a cached render is in place, leave it; otherwise
      // surface a banner so the empty chat isn't ambiguous.
      if (this.focusedAgent === agent && cached.length === 0) {
        this.historyError = "Couldn't load history (network)";
      }
    } finally {
      if (this.focusedAgent === agent) this.loadingInitial = false;
    }
  }

  /**
   * Fetch and prepend the next older page of turns. Idempotent on re-entry
   * via `loadingOlder`. Stops once a fetch returns empty (`reachedOldest`).
   *
   * Holds `loadingOlder = true` for at least MIN_LOADING_MS so the floating
   * indicator pill is actually visible — localhost pagination commonly
   * completes in <50ms, which would otherwise mean a single-frame flicker
   * the user can't perceive.
   */
  async loadOlderTurns(opts?: {
    /** Fires synchronously after `chat.messages` is prepended and before
     *  the artificial MIN_LOADING_MS spinner-hold delay. The IntersectionObserver
     *  that triggered this call needs the hook here (not on the promise
     *  resolution, which is gated by the delay) so it can fix scrollTop
     *  immediately after the DOM has the new content — otherwise the user
     *  sees ~350ms of unanchored scroll before the fix lands. */
    onPrepended?: () => void;
  }): Promise<void> {
    if (this.loadingOlder || this.reachedOldest) return;
    if (this.oldestDbId === null) return;
    const MIN_LOADING_MS = 350;
    const agent = this.focusedAgent;
    const beforeId = this.oldestDbId;
    this.loadingOlder = true;
    const startedAt = Date.now();
    try {
      const r = await fetchWithTimeout(
        `/api/agents/${agent}/turns?limit=50&beforeId=${beforeId}`,
        { timeoutMs: 15_000 },
      );
      if (!r.ok) return;
      const turns = (await r.json()) as TurnRow[];
      // Bail if the user switched agents while the fetch was in flight.
      // Without this we would prepend the prior agent's turns onto the
      // new agent's messages and overwrite `oldestDbId` with a value
      // that doesn't belong to the focused agent — subsequent
      // pagination would fetch wrong data or trip `reachedOldest`.
      if (this.focusedAgent !== agent) return;
      if (turns.length === 0) {
        this.reachedOldest = true;
        return;
      }
      const older = parseTurns(turns, agent);
      // Prepend, dedup-by-id (SSE may have surfaced something we now also
      // see in DB).
      const seen = new Set(this.messages.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      this.messages = [...fresh, ...this.messages];
      this.oldestDbId = oldestDbTurnId(turns);
      opts?.onPrepended?.();
    } catch {
      // ignore
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_LOADING_MS) {
        await new Promise((resolve) =>
          setTimeout(resolve, MIN_LOADING_MS - elapsed),
        );
      }
      // Only clear the flag if we still own this load — if the user
      // switched agents mid-flight, `loadAgentTurns` already reset
      // `loadingOlder` for the new agent and a fresh `loadOlderTurns`
      // may have set it back to `true`. Clobbering that here would
      // confuse the IntersectionObserver guard.
      if (this.focusedAgent === agent) {
        this.loadingOlder = false;
      }
    }
  }

  /** Per-agent dedup. Returns true if the event should be applied (the
   * seq is strictly greater than the agent's current cursor); also bumps
   * the cursor. Events without an `agent` field land in `__system__`. */
  private acceptEvent(event: WireEvent): boolean {
    const bucket =
      "agent" in event && typeof event.agent === "string"
        ? event.agent
        : SYSTEM_BUCKET;
    const cur = this.lastSeqByAgent[bucket] ?? 0;
    if (event.seq <= cur) return false;
    this.lastSeqByAgent[bucket] = event.seq;
    return true;
  }

  applyEvent(event: WireEvent): void {
    if (!this.acceptEvent(event)) return;

    switch (event.type) {
      case "turn_started":
        if (event.agent === this.focusedAgent) {
          this.inflightTurnId = event.turn_id;
        }
        break;
      case "block_start":
        if (event.agent !== this.focusedAgent) break;
        this.handleBlockStart(event);
        break;
      case "block_delta":
        if (event.agent !== this.focusedAgent) break;
        this.handleBlockDelta(event);
        break;
      case "block_complete":
        if (event.agent !== this.focusedAgent) break;
        this.handleBlockComplete(event);
        break;
      case "block_reload":
        if (event.agent !== this.focusedAgent) break;
        // Daemon's JSONL recovery scan inserted/updated rows for this agent
        // (FIX_FORWARD 1.3). Re-seed history so the dashboard mirrors the
        // canonical blocks table.
        void this.loadAgentTurns(event.agent);
        break;
      case "turn_done":
        if (event.agent !== this.focusedAgent) break;
        this.finishTurn(event.turn_id, event.status);
        break;
      case "error":
        if (event.agent !== this.focusedAgent) break;
        if (event.turn_id) this.finishTurn(event.turn_id, "error");
        break;
      case "agent_lifecycle":
        if (event.event === "spawn") {
          this.upsertAgent(event.agent, {
            type: event.agentType,
            status: "working",
          });
        } else if (event.event === "kill") {
          // FIX_FORWARD 3.6: daemon destroyed the agent's registry row.
          // Drop the sidebar entry locally rather than waiting for a poll.
          this.removeAgent(event.agent);
        }
        break;
      case "agent_status":
        this.applyAgentStatus(event.agent, event.status);
        break;
      case "agent_message":
        // FIX_FORWARD 3.6: badge unfocused agents on new user-visible
        // block_complete. The focused agent never accumulates a badge —
        // the user is already reading the chat.
        if (event.agent !== this.focusedAgent) {
          this.bumpUnread(event.agent);
        }
        break;
      case "mail_delivered":
        // Treat as a (lighter-weight) unread signal — recipient just got
        // mail, which warrants a sidebar nudge. The canonical block lands
        // separately via `agent_message` once the recipient acts on the
        // mail; this just gets the badge up faster.
        if (event.to !== this.focusedAgent) {
          this.bumpUnread(event.to);
        }
        break;
      default:
        break;
    }
  }

  /* ------------ Block-level streaming handlers (FIX_FORWARD 1.7) ------------ */

  private handleBlockStart(event: {
    block_id: string;
    block_index: number;
    role: string;
    kind: "text" | "thinking" | "tool_use" | "tool_result";
    turn_id: string;
    tool?: { id: string; name: string };
    ts: number;
  }): void {
    if (event.kind === "text") {
      const role = event.role === "user" ? "user" : "assistant";
      // FIX_FORWARD 2.6: user blocks key by turn_id so the local pending
      // bubble (re-keyed on POST-success) and the canonical block from the
      // daemon converge on the same row.
      const id =
        role === "user" ? userBlockIdForTurn(event.turn_id) : `b_${event.block_id}`;
      if (this.messages.some((m) => m.id === id)) return;
      this.messages.push({
        id,
        role,
        text: "",
        status: role === "user" ? "complete" : "streaming",
        agent: this.focusedAgent,
        turnId: event.turn_id,
        ts: event.ts,
      });
      return;
    }
    if (event.kind === "thinking") {
      const id = `th_${event.block_id}`;
      if (this.messages.some((m) => m.id === id)) return;
      this.messages.push({
        id,
        role: "thinking",
        text: "",
        status: "running",
        blockId: event.block_id,
        ts: event.ts,
      });
      return;
    }
    if (event.kind === "tool_use") {
      const toolId = event.tool?.id ?? event.block_id;
      const id = `t_${toolId}`;
      if (this.messages.some((m) => m.id === id)) return;
      this.messages.push({
        id,
        role: "tool",
        text: "",
        status: "running",
        toolId,
        toolName: event.tool?.name ?? "",
        ts: event.ts,
      });
      return;
    }
    // tool_result: created lazily on block_complete (we need content_json
    // to know which tool_use_id it belongs to).
  }

  private handleBlockDelta(event: {
    block_id: string;
    delta: { text?: string; partial_json?: string };
  }): void {
    const textId = `b_${event.block_id}`;
    const thinkId = `th_${event.block_id}`;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.id === textId) {
        if (typeof event.delta.text === "string" && m.status === "streaming") {
          m.text += event.delta.text;
        }
        return;
      }
      if (m.id === thinkId) {
        if (typeof event.delta.text === "string" && m.status === "running") {
          m.text += event.delta.text;
        }
        return;
      }
    }
    // tool_use input deltas don't render incrementally — the canonical input
    // arrives via block_complete's content_json.
  }

  private handleBlockComplete(event: {
    block_id: string;
    kind: "text" | "thinking" | "tool_use" | "tool_result";
    content_json: string;
    status: "complete" | "aborted" | "error";
    turn_id: string;
    role: string;
    ts: number;
  }): void {
    const parsed = parseBlockContent(event.content_json);
    if (event.kind === "text") {
      const id =
        event.role === "user"
          ? userBlockIdForTurn(event.turn_id)
          : `b_${event.block_id}`;
      for (const m of this.messages) {
        if (m.id !== id) continue;
        if (typeof parsed.text === "string") m.text = parsed.text;
        m.status =
          event.status === "complete"
            ? "complete"
            : event.status === "aborted"
              ? "aborted"
              : "error";
        return;
      }
      // Late mount: block_start was evicted from the ring.
      const role = event.role === "user" ? "user" : "assistant";
      this.messages.push({
        id,
        role,
        text: parsed.text ?? "",
        status:
          event.status === "complete"
            ? "complete"
            : event.status === "aborted"
              ? "aborted"
              : "error",
        agent: this.focusedAgent,
        turnId: event.turn_id,
        ts: event.ts,
      });
      return;
    }
    if (event.kind === "thinking") {
      const id = `th_${event.block_id}`;
      for (const m of this.messages) {
        if (m.id !== id) continue;
        if (typeof parsed.text === "string") m.text = parsed.text;
        m.status = "done";
        return;
      }
      this.messages.push({
        id,
        role: "thinking",
        text: parsed.text ?? "",
        status: "done",
        blockId: event.block_id,
        ts: event.ts,
      });
      return;
    }
    if (event.kind === "tool_use") {
      const toolId = parsed.tool_use_id ?? "";
      const id = `t_${toolId}`;
      for (const m of this.messages) {
        if (m.id !== id) continue;
        m.input = parsed.input;
        if (parsed.name && !m.toolName) m.toolName = parsed.name;
        return;
      }
      // Late mount.
      this.messages.push({
        id,
        role: "tool",
        text: "",
        status: "running",
        toolId,
        toolName: parsed.name ?? "",
        input: parsed.input,
        ts: event.ts,
      });
      return;
    }
    if (event.kind === "tool_result") {
      const toolId = parsed.tool_use_id ?? "";
      const id = `t_${toolId}`;
      for (const m of this.messages) {
        if (m.id !== id) continue;
        m.status = parsed.is_error ? "error" : "done";
        if (typeof parsed.text === "string") m.output = parsed.text;
        return;
      }
      // No preceding tool_use bubble — likely a ring eviction. Synthesize one.
      this.messages.push({
        id,
        role: "tool",
        text: "",
        status: parsed.is_error ? "error" : "done",
        toolId,
        toolName: "(unknown)",
        output: parsed.text ?? "",
        ts: event.ts,
      });
    }
  }
}

export const chat = new ChatState();

/** Parsed shape of a block row's `content_json`. Mirrors what the daemon
 *  writes for each block kind (FIX_FORWARD 1.2 + 1.3). */
interface ParsedBlockContent {
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  name?: string;
  input?: unknown;
  is_error?: boolean;
  from_agent?: string;
}

function parseBlockContent(contentJson: string): ParsedBlockContent {
  try {
    return JSON.parse(contentJson) as ParsedBlockContent;
  } catch {
    return {};
  }
}

/** Wire shape of a row from `GET /api/agents/:name/blocks`. Mirrors the
 *  `blocks` table columns (FIX_FORWARD 1.1). */
export interface BlockRow {
  id: number;
  blockId: string;
  turnId: string;
  agentName: string;
  sessionId: string;
  messageId: string | null;
  blockIndex: number;
  role: string;
  kind: string;
  source: string | null;
  contentJson: string;
  status: string;
  ts: number;
  lastEventSeq: number;
}

/**
 * Convert BlockRow[] (from /api/agents/:name/blocks) into the ChatMessage[]
 * the chat UI renders. Mirrors `handleBlockComplete`'s id scheme so a
 * canonical block row + a live block_complete SSE event converge on the
 * same bubble id (FIX_FORWARD 3.7 + 2.6).
 */
export function parseBlocks(blocks: BlockRow[], agent: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const toolByToolId = new Map<string, ChatMessage>();
  // Newest-first arrives from the API; chronological for rendering.
  const sorted = [...blocks].sort((a, b) => a.id - b.id);
  for (const b of sorted) {
    const parsed = parseBlockContent(b.contentJson);
    if (b.kind === "text") {
      const role = b.role === "user" ? "user" : "assistant";
      const id =
        role === "user" ? userBlockIdForTurn(b.turnId) : `b_${b.blockId}`;
      out.push({
        id,
        role,
        text: parsed.text ?? "",
        status:
          b.status === "complete" || b.status === "streaming"
            ? "complete"
            : b.status === "aborted"
              ? "aborted"
              : "error",
        agent,
        turnId: b.turnId,
        ts: b.ts,
        source: (b.source as ChatMessage["source"]) ?? undefined,
      });
    } else if (b.kind === "thinking") {
      out.push({
        id: `th_${b.blockId}`,
        role: "thinking",
        text: parsed.text ?? "",
        status: "done",
        blockId: b.blockId,
        ts: b.ts,
      });
    } else if (b.kind === "tool_use") {
      const toolId = parsed.tool_use_id ?? b.blockId;
      // Dedup duplicate tool_use rows for the same id — JSONL replay
      // artifacts and refork retries can both produce them.
      if (toolByToolId.has(toolId)) continue;
      const msg: ChatMessage = {
        id: `t_${toolId}`,
        role: "tool",
        text: "",
        status: "running",
        toolId,
        toolName: parsed.name ?? "",
        input: parsed.input,
        ts: b.ts,
      };
      out.push(msg);
      toolByToolId.set(toolId, msg);
    } else if (b.kind === "tool_result") {
      const toolId = parsed.tool_use_id ?? "";
      const status = parsed.is_error ? "error" : "done";
      const existing = toolByToolId.get(toolId);
      if (existing) {
        existing.status = status;
        existing.output = parsed.text ?? "";
      } else {
        const synth: ChatMessage = {
          id: `t_${toolId}`,
          role: "tool",
          text: "",
          status,
          toolId,
          toolName: "(unknown)",
          output: parsed.text ?? "",
          ts: b.ts,
        };
        out.push(synth);
        toolByToolId.set(toolId, synth);
      }
    }
  }
  return out;
}

/** Lowest block_id across an array. Used as the next `before` cursor for
 *  scroll-up pagination (FIX_FORWARD 3.7). */
export function oldestBlockCursor(blocks: BlockRow[]): string | null {
  let oldest: BlockRow | null = null;
  for (const b of blocks) {
    if (oldest === null || b.id < oldest.id) oldest = b;
  }
  return oldest?.blockId ?? null;
}

/**
 * Lightweight NL-ish date parser for `/jump` (FIX_FORWARD 6.1). Recognizes
 * the most common cases:
 *   - "today", "yesterday", "now"
 *   - "N days ago" / "N hours ago" / "N minutes ago"
 *   - ISO 8601, RFC 2822, or anything else Date.parse handles
 *
 * Returns the matched timestamp in unix ms, or `null` to fall through to
 * the term-search path. A full chrono-node integration could replace this
 * later without changing the public API.
 */
export function parseJumpDate(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const now = Date.now();
  if (trimmed === "now") return now;
  if (trimmed === "today") {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  }
  if (trimmed === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  }
  const rel = trimmed.match(/^(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)\s+ago$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms =
      unit.startsWith("minute")
        ? n * 60_000
        : unit.startsWith("hour")
          ? n * 3_600_000
          : unit.startsWith("week")
            ? n * 7 * 86_400_000
            : n * 86_400_000;
    return now - ms;
  }
  // Last resort: Date.parse. Filter out values too far from "now" to be
  // a real date the user typed — bare integers like "42" coerce to
  // 1970-01-01, which we don't want to treat as a date.
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) return null;
  const year = new Date(parsed).getFullYear();
  if (year < 2000 || year > 2100) return null;
  return parsed;
}

export interface TurnRow {
  id: number;
  role: string;
  kind: string;
  contentJson: string;
  ts: number;
}

/**
 * Parse JSONL turn rows into ChatMessage[]. Used by both the active loader
 * (which writes into the global `chat.messages`) and the read-only past-
 * session view (which keeps its own array). Stable bubble ids ensure SSE
 * replays on top of an active load don't duplicate content.
 */
export function parseTurns(turns: TurnRow[], agent: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  const sorted = [...turns].reverse();
  const toolByToolId = new Map<string, ChatMessage>();

  for (const t of sorted) {
    const blocks = extractBlocks(t.contentJson);
    for (const b of blocks) {
      if (b.kind === "text") {
        const id = b.messageId
          ? `assistant_${b.messageId}`
          : `db_${t.id}_${b.index}`;
        out.push({
          id,
          role: t.role === "user" ? "user" : "assistant",
          text: b.text,
          status: "complete",
          ts: t.ts,
          agent,
          dbTurnId: t.id,
        });
      } else if (b.kind === "tool_use") {
        // Same tool_use_id can appear in the JSONL more than once when a
        // worker resumed mid-stream or the mirror ingested the same
        // session twice. Dedup so the Svelte each-key stays unique;
        // input/toolName from the first occurrence wins.
        if (toolByToolId.has(b.toolId)) continue;
        const msg: ChatMessage = {
          id: `t_${b.toolId}`,
          role: "tool",
          text: "",
          status: "running",
          toolId: b.toolId,
          toolName: b.toolName,
          input: b.input,
          ts: t.ts,
          dbTurnId: t.id,
        };
        out.push(msg);
        toolByToolId.set(b.toolId, msg);
      } else if (b.kind === "tool_result") {
        const msg = toolByToolId.get(b.toolId);
        if (msg) {
          msg.status = b.isError ? "error" : "done";
          msg.output = b.text;
        } else {
          // Orphan tool_result (the preceding tool_use was evicted or
          // missing). Synthesize a bubble, but register it so a second
          // orphan with the same id doesn't collide.
          const synth: ChatMessage = {
            id: `t_${b.toolId}`,
            role: "tool",
            text: "",
            status: b.isError ? "error" : "done",
            toolId: b.toolId,
            toolName: "(unknown)",
            output: b.text,
            ts: t.ts,
            dbTurnId: t.id,
          };
          out.push(synth);
          toolByToolId.set(b.toolId, synth);
        }
      } else if (b.kind === "thinking") {
        const blockId = b.messageId
          ? `${b.messageId}_${b.index}`
          : `db_${t.id}_${b.index}`;
        out.push({
          id: `th_${blockId}`,
          role: "thinking",
          text: b.text,
          status: "done",
          blockId,
          ts: t.ts,
          dbTurnId: t.id,
        });
      }
    }
  }
  return out;
}

/** Returns the smallest `id` among the given turn rows, or null if empty. */
function oldestDbTurnId(turns: TurnRow[]): number | null {
  let oldest: number | null = null;
  for (const t of turns) {
    if (oldest === null || t.id < oldest) oldest = t.id;
  }
  return oldest;
}

/** Extracted block from a JSONL entry, ordered as it appears in the file. */
type ExtractedBlock =
  | { kind: "text"; index: number; text: string; messageId?: string }
  | {
      kind: "tool_use";
      index: number;
      toolId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: "tool_result";
      index: number;
      toolId: string;
      text: string;
      isError: boolean;
    }
  | { kind: "thinking"; index: number; text: string; messageId?: string };

/**
 * Extract content blocks from a Claude-SDK JSONL entry. Handles both the
 * canonical message shape (with `message.content[]`) and the simpler
 * streaming-row shape (`{text: "..."}`).
 */
function extractBlocks(contentJson: string): ExtractedBlock[] {
  const out: ExtractedBlock[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return out;
  }
  const j = parsed as {
    text?: string;
    message?: {
      id?: string;
      content?: Array<{
        type?: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      }>;
    };
  };
  if (typeof j.text === "string" && j.text.length > 0) {
    out.push({ kind: "text", index: 0, text: j.text });
    return out;
  }
  const messageId = j.message?.id;
  if (Array.isArray(j.message?.content)) {
    j.message.content.forEach((b, idx) => {
      if (b.type === "text" && typeof b.text === "string") {
        out.push({ kind: "text", index: idx, text: b.text, messageId });
      } else if (b.type === "tool_use") {
        out.push({
          kind: "tool_use",
          index: idx,
          toolId: b.id ?? `idx_${idx}`,
          toolName: b.name ?? "",
          input: b.input,
        });
      } else if (b.type === "tool_result") {
        out.push({
          kind: "tool_result",
          index: idx,
          toolId: b.tool_use_id ?? "",
          text: stringifyToolResult(b.content),
          isError: b.is_error === true,
        });
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        out.push({ kind: "thinking", index: idx, text: b.thinking, messageId });
      }
    });
  }
  return out;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: string }).type === "text" &&
          typeof (b as { text?: string }).text === "string",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}
