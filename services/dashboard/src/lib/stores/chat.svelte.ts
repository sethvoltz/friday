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
  /** Oldest `block_id` we've loaded; pagination cursor for older blocks.
   *  Used as the `before` query param on `/api/agents/:name/blocks`. */
  oldestBlockId = $state<string | null>(null);
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
    const targetId = userBlockIdForTurn(turnId);
    const optIdx = this.messages.findIndex((m) => m.queueId === queueId);
    if (optIdx < 0) return;
    // Defense in depth against an SSE-first race: if the daemon's
    // `block_complete` SSE frame arrived *before* the POST /api/chat/turn
    // response (and so before this confirmPending call), `handleBlockComplete`
    // already pushed a canonical bubble with `id=userBlockIdForTurn(turnId)`.
    // Re-keying the optimistic in place would create two messages sharing
    // the same id, crashing the keyed `{#each}`. Drop the optimistic in
    // that case — the SSE bubble is the canonical one.
    //
    // The daemon-side change in `recordUserBlock` (skipping the SSE emit
    // for `user_chat` source) should make this path unreachable in
    // practice, but the check stays as belt-and-braces for the `mail` /
    // `scheduled` SSE paths where the SSE frame is the sole source.
    const sseAlreadyHere = this.messages.some(
      (m, i) => i !== optIdx && m.id === targetId,
    );
    if (sseAlreadyHere) {
      this.messages = this.messages.filter((_, i) => i !== optIdx);
      return;
    }
    const m = this.messages[optIdx];
    m.id = targetId;
    m.turnId = turnId;
    m.pending = false;
    m.failed = false;
    m.retrying = false;
    m.queueId = undefined;
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
   * id (the normal case). For canonical-block ids of the same content
   * `parseBlocks` returns `b_<blockId>`; the assistant SSE delta path keys
   * by message_id for cross-stream stability across SDK resumes.
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
    this.oldestBlockId = null;
    this.reachedOldest = false;
    this.historyError = null;
    // Clear any stale loading-older flag from the previous agent. Without
    // this, if the user scrolled up in agent A and clicked away before
    // the load finished, A's `loadingOlder=true` would persist into B's
    // chat and block B's first pagination request until A's stale finally
    // fires (~350ms later). The new guards in `loadOlderTurns` ensure
    // that stale call won't clobber B's state.
    this.loadingOlder = false;

    // Build the queue-synth bubbles once — we append them after both the
    // cached-render and the live-fetch overwrite so they're never wiped
    // by `this.messages = parseBlocks(...)`. Without this, a page reload
    // while a message is queued (offline / 5xx) would briefly show the
    // bubble and then lose it.
    const queueSynth: ChatMessage[] = sendQueue.forAgent(agent).map((q) => ({
      id: `u_queue_${q.id}`,
      role: "user" as const,
      text: q.text,
      status: "complete" as const,
      ts: q.createdAt,
      queueId: q.id,
      attachments: q.attachments,
    }));

    // Last-known transcript from a previous session. Render the cached
    // blocks immediately so a slow / offline first-paint doesn't show an
    // empty chat. The live fetch below replaces this once it lands; the
    // bubble ids are stable across cache → fresh (parseBlocks uses
    // userBlockIdForTurn for user blocks and b_<blockId> for assistant),
    // so any in-flight SSE deltas attach cleanly.
    const cached = loadJSON<BlockRow[]>(KEYS.transcript(agent), []);
    if (cached.length > 0) {
      this.messages = [...parseBlocks(cached, agent), ...queueSynth];
      this.oldestBlockId = oldestBlockCursor(cached);
    } else if (queueSynth.length > 0) {
      this.messages = [...queueSynth];
    }

    this.loadingInitial = cached.length === 0;

    try {
      // FIX_FORWARD 3.8: client-picked initial page size based on viewport
      // + network class. Server clamps to ≤200 regardless.
      const limit = initialPageSize();
      const r = await fetchWithTimeout(
        `/api/agents/${agent}/blocks?limit=${limit}`,
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
      const payload = (await r.json()) as {
        blocks: BlockRow[];
        lastEventSeq?: number;
      };
      if (this.focusedAgent !== agent) return;
      const blocks = payload.blocks ?? [];
      // Queue-synth is appended AFTER the live blocks so queued bubbles
      // survive the wholesale array replacement. parseBlocks returns in
      // chronological order (oldest first); the queue items represent
      // not-yet-sent user input that conceptually sits at the bottom
      // until the daemon assigns turn_ids and the SSE confirmation
      // arrives.
      this.messages = [...parseBlocks(blocks, agent), ...queueSynth];
      this.oldestBlockId = oldestBlockCursor(blocks);
      // Seed the per-agent SSE cursor from the snapshot's high-water
      // mark. The daemon updates `last_event_seq` on every block_delta
      // (so the row's content_json reflects deltas up to that seq);
      // by advancing the cursor to match, replayed deltas with
      // `seq <= cursor` are dropped by `acceptEvent` and we don't
      // double-append the partial text that's already in the row.
      // Without this seeding, a mid-turn reload would render the
      // partial text from /blocks and then re-append the same deltas
      // when SSE replays them — corrupt markdown, duplicate content.
      const seqHwm = payload.lastEventSeq ?? 0;
      if (seqHwm > 0) {
        this.lastSeqByAgent[agent] = Math.max(
          this.lastSeqByAgent[agent] ?? 0,
          seqHwm,
        );
      }
      if (blocks.length === 0) {
        this.reachedOldest = true;
      } else {
        // Trim before persisting: localStorage caps around 5MB per origin
        // and content_json can carry sizable tool inputs/outputs. Cap at
        // the initial-page heuristic so the cached payload tracks the
        // first-paint window.
        saveJSON(KEYS.transcript(agent), blocks.slice(0, limit));
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

    // Restore `inflightTurnId` so the Send button correctly shows Stop on
    // reload-during-turn. Without this, a hard refresh while the daemon
    // is mid-turn leaves the UI claiming the agent is idle even though
    // SSE deltas may still arrive. The probe is best-effort: on network
    // failure, `inflightTurnId` stays null and the next `turn_started`
    // SSE frame populates it.
    if (this.focusedAgent !== agent) return;
    try {
      const ar = await fetchWithTimeout(
        `/api/agents/${encodeURIComponent(agent)}`,
        { timeoutMs: 5_000 },
      );
      if (!ar.ok) return;
      if (this.focusedAgent !== agent) return;
      const entry = (await ar.json()) as { status?: string };
      if (entry.status !== "working") return;
      // Find the most recent bubble carrying a turnId — that's the
      // current in-flight turn. Prefer streaming assistant blocks, fall
      // back to the latest bubble overall. If no turnId is recoverable
      // (worker just spawned, no blocks emitted yet), leave
      // `inflightTurnId` null; the next `turn_started` SSE frame will
      // populate it.
      let latestTurnId: string | undefined;
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (m.turnId) {
          latestTurnId = m.turnId;
          break;
        }
      }
      if (latestTurnId) this.inflightTurnId = latestTurnId;
    } catch {
      // ignore — fallback path is the next turn_started SSE frame.
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
    if (this.oldestBlockId === null) return;
    const MIN_LOADING_MS = 350;
    const agent = this.focusedAgent;
    const before = this.oldestBlockId;
    this.loadingOlder = true;
    const startedAt = Date.now();
    try {
      const r = await fetchWithTimeout(
        `/api/agents/${agent}/blocks?limit=50&before=${encodeURIComponent(before)}`,
        { timeoutMs: 15_000 },
      );
      if (!r.ok) return;
      const payload = (await r.json()) as { blocks: BlockRow[] };
      // Bail if the user switched agents while the fetch was in flight.
      // Without this we would prepend the prior agent's blocks onto the
      // new agent's messages and overwrite `oldestBlockId` with a value
      // that doesn't belong to the focused agent — subsequent
      // pagination would fetch wrong data or trip `reachedOldest`.
      if (this.focusedAgent !== agent) return;
      const blocks = payload.blocks ?? [];
      if (blocks.length === 0) {
        this.reachedOldest = true;
        return;
      }
      const older = parseBlocks(blocks, agent);
      // Prepend, dedup-by-id (SSE may have surfaced something we now also
      // see in DB).
      const seen = new Set(this.messages.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      this.messages = [...fresh, ...this.messages];
      this.oldestBlockId = oldestBlockCursor(blocks);
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
      // Preserve the row's `streaming` state. On reload during a turn,
      // the assistant block is still being filled — collapsing it to
      // `complete` here would make `handleBlockDelta` reject every
      // subsequent SSE delta (it gates on `m.status === "streaming"`)
      // and the user would see a frozen replay instead of a live
      // resumption. User blocks are always finalized at insert time
      // so they map cleanly to `complete`.
      const status: ChatMessage["status"] =
        role === "user"
          ? "complete"
          : b.status === "streaming"
            ? "streaming"
            : b.status === "complete"
              ? "complete"
              : b.status === "aborted"
                ? "aborted"
                : "error";
      out.push({
        id,
        role,
        text: parsed.text ?? "",
        status,
        agent,
        turnId: b.turnId,
        ts: b.ts,
        source: (b.source as ChatMessage["source"]) ?? undefined,
      });
    } else if (b.kind === "thinking") {
      // Same shape for thinking blocks. `handleBlockDelta` gates on
      // `m.status === "running"` for thinking; preserve "running"
      // for streaming rows so reload-mid-turn deltas append.
      out.push({
        id: `th_${b.blockId}`,
        role: "thinking",
        text: parsed.text ?? "",
        status: b.status === "streaming" ? "running" : "done",
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

