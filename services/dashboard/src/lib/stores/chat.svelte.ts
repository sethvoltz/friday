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
    | "stopping" // user clicked Stop; daemon hasn't confirmed yet
    | "complete"
    | "aborted"
    | "error"
    | "running" // tool/thinking still in progress
    | "done"
    // User block recorded by the daemon at status='queued' — sitting in the
    // worker's `nextPrompts` FIFO behind an in-flight turn. Pinned to the
    // bottom of the chat (alongside `pending`) until a `block_meta_update`
    // event flips it to 'complete' with a fresh ts. Carries an X cancel
    // affordance that yanks it from the daemon's queue and stuffs the
    // text back into the input bar.
    | "queued";
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
  source?:
    | "user_chat"
    | "mail"
    | "queue_inject"
    | "sdk"
    | "scratch"
    | "agent_spawn"
    | "schedule"
    | "refork_notice";

  /** Sender attribution for `source='mail'` blocks. Pulled from
   *  `content_json.from_agent`, written by `recordUserBlock` at
   *  daemon/agent/lifecycle.ts when the mail-bridge materializes incoming
   *  mail. Undefined for non-mail user blocks. */
  fromAgent?: string;

  /** Extra mail-row metadata for `source='mail'` blocks (id/subject/type/
   *  priority/threadId/ts). Serialized into content_json by the daemon
   *  so MailBlock can render rich detail without a separate fetch. */
  mailMeta?: {
    id: number;
    subject: string | null;
    type: string;
    priority: string;
    threadId: string | null;
    ts: number;
  };

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

  /** When set to `"error"`, this bubble is a synthetic error notification
   *  (FRI-12) emitted by the daemon when the SDK throws (529, 429, 401,
   *  network) or the stop force-kill safety net fires. The bubble's
   *  `role` stays `"assistant"` so it slots into the assistant lane;
   *  ChatMessages discriminates on `kind` to render the ErrorBlock with
   *  Resend / Resume / Details affordances. */
  kind?: "error";
  errorCode?: string;
  errorHeadline?: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  requestId?: string;
  rawErrorMessage?: string;
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
  /** ISO timestamps from the agents table. Sidebar uses `updatedAt`
   * (fallback `createdAt`) to bucket rows by age. Optional because SSE-
   * synthesized entries that arrive before the first /api/agents poll
   * don't carry them yet. */
  createdAt?: string;
  updatedAt?: string;
}

/** Shape returned by `/api/agents/:name/sessions` and cached on the chat
 *  store for the sidebar's history submenu. */
export interface SidebarSessionSummary {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  turnCount: number;
}

/** Sentinel agent bucket for SSE events that don't carry an `agent` field
 *  (system_banner, mail_delivered, schedule_fired, evolve_critical). */
export const SYSTEM_BUCKET = "__system__";

/** Claude Agent SDK tombstone for turns that ended without assistant output.
 *  The SDK writes this literal into the session JSONL so resumed sessions
 *  preserve the "this turn happened but produced nothing" signal. The
 *  daemon's jsonl-mirror faithfully ingests it as a `text` block; we keep
 *  the row on disk (preserve-over-delete) but suppress it from the chat
 *  UI so it doesn't render as a ghost assistant bubble. */
const SDK_NO_RESPONSE_SENTINEL = "No response requested.";

function isNoResponseSentinel(role: string, text: string | undefined): boolean {
  return role !== "user" && text?.trim() === SDK_NO_RESPONSE_SENTINEL;
}

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
  /**
   * Per-agent inflight turn tracking (FRI-12). Was previously a single
   * global value; that meant a wedged turn on agent A leaked into agent
   * B's input bar — switching to B showed Stop instead of Send because
   * `busy = chat.inflightTurnId !== null` had no agent context. Now each
   * agent's slot is tracked independently and the public `inflightTurnId`
   * getter resolves against the focused agent.
   */
  inflightTurnIdByAgent = $state<Record<string, string | null>>({});
  /**
   * Backwards-compatible accessor: returns the focused agent's slot, or
   * null when that agent has no in-flight turn. ChatInput.svelte's
   * `busy = chat.inflightTurnId !== null` derivation reads this and stays
   * reactive because the getter touches both `focusedAgent` and the map.
   */
  get inflightTurnId(): string | null {
    return this.inflightTurnIdByAgent[this.focusedAgent] ?? null;
  }
  /**
   * Setter writes to the focused agent's slot. Used by the optimistic-
   * send path in ChatInput.svelte where the user is, by definition,
   * acting on the focused agent.
   */
  set inflightTurnId(turnId: string | null) {
    this.inflightTurnIdByAgent[this.focusedAgent] = turnId;
  }
  /**
   * Explicit per-agent setter. Use this when the agent is known but may
   * not be the focused one (e.g., SSE turn_started for a background
   * agent).
   */
  markInflight(agent: string, turnId: string | null): void {
    this.inflightTurnIdByAgent[agent] = turnId;
  }
  connected = $state(false);
  /** Per-agent unread badge counts (FIX_FORWARD 3.6). Bumped by SSE
   *  `agent_message` events while another agent is focused; cleared when
   *  the user focuses the agent. */
  unreadByAgent = $state<Record<string, number>>({});
  /** Transient toast surfaced by client-side commands (FIX_FORWARD 6.1).
   *  `null` when no toast is active. ChatShell mounts a floating pill. */
  toast = $state<{ message: string; level: "info" | "warn" } | null>(null);
  /** Bubble id to highlight after a `/jump <term>` (FIX_FORWARD 6.1). The
   *  matching ChatMessage element gets a one-shot pulse animation via the
   *  `jump-highlight` class. Self-clears via the bubble's `animationend`
   *  handler when the CSS animation finishes, so the class state mirrors
   *  the animation lifecycle — no setTimeout coordination, and a follow-
   *  up `/jump` to the same id re-toggles the class to re-trigger. */
  highlightedMessageId = $state<string | null>(null);
  /** Nonce-keyed scroll target. ChatMessages watches this and calls
   *  `scrollIntoView` for the matching element. The nonce changes on every
   *  request, so repeated jumps to the same bubble id still trigger a fresh
   *  scroll. Set by `jumpTo` (both date- and term-mode paths). Separate
   *  from `highlightedMessageId` so date jumps scroll without a pulse. */
  scrollTarget = $state<{ id: string; nonce: number } | null>(null);
  private scrollNonce = 0;
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

  /** Sidebar history-expand state. Lives on the chat store (not the
   *  Sidebar component) so it survives ChatShell re-mounts on route
   *  navigation — without this, every nav between `/` and
   *  `/sessions/<agent>` collapsed every expand the user had open. */
  sidebarExpanded = $state<Record<string, boolean>>({});
  /** Cached past-session summaries keyed by agent name. Fetched once on
   *  first expand; persists across Sidebar mounts. */
  sidebarPastSessions = $state<Record<string, SidebarSessionSummary[]>>({});
  /** Per-agent inflight flag for the sessions fetch. */
  sidebarLoadingSessions = $state<Record<string, boolean>>({});

  /** localStorage key for F3-C cursor persistence. Cleared when the
   *  daemon's boot_id changes (different process — old seqs are stale). */
  private static readonly LAST_SEQ_KEY = "chat:lastSeqByAgent";

  constructor() {
    // F3-C (PR C): hydrate the per-agent SSE dedup cursor from
    // localStorage. Without this, every page reload reset the cursor to
    // empty and the daemon's ring-buffer replay re-counted old
    // `agent_message` events, producing phantom unread badges. The cursor
    // is invalidated separately when the connection_established event
    // carries a new boot_id (see acceptConnectionEstablished).
    const persisted = loadJSON<Record<string, number>>(
      ChatState.LAST_SEQ_KEY,
      {},
    );
    if (persisted && typeof persisted === "object") {
      this.lastSeqByAgent = { ...persisted };
    }
  }

  /** Insert or refresh a local AgentInfo entry. Used when SSE events arrive
   * for an agent the periodic `/api/agents` poll hasn't reported yet
   * (newly spawned). The next poll fills in details we don't know here.
   *
   * F2-B: refuse to insert without a known `type`. SSE events like
   * `agent_status` carry no type, so an event for an agent we haven't
   * seen before used to create a row with type="unknown" — which
   * rendered as a literal UNKNOWN label in the sidebar until the next
   * spawn event landed. Better to drop the upsert and wait for either
   * a lifecycle event (which has `type`) or the next /api/agents poll. */
  upsertAgent(
    name: string,
    patch: Partial<Omit<AgentInfo, "name">>,
  ): void {
    const i = this.agents.findIndex((a) => a.name === name);
    if (i === -1) {
      if (!patch.type) return;
      this.agents.push({
        name,
        type: patch.type,
        status: patch.status ?? "idle",
        sessionId: patch.sessionId,
        sessionCount: patch.sessionCount,
      });
      return;
    }
    const cur = this.agents[i];
    this.agents[i] = { ...cur, ...patch };
  }

  /** Drop an agent from the sidebar list. Reserved for future cleanup
   *  paths; the `agent_lifecycle: archive` handler marks status instead so
   *  the row stays in the sidebar under "Show archived". */
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
   * non-binary states (stalled/error/archived) apply immediately.
   *
   * Archived is terminal: an SSE ring-buffer replay on cold page load can
   * deliver stale `agent_status` events for already-archived agents (the
   * F3-C cursor is empty before the first event accepts). Without a guard
   * here, the row flips from "archived" back to whatever the replay says,
   * the sidebar lights up green, and the user sees a corpse mid-turn.
   * Refusing to overwrite "archived" status closes that hole. */
  private applyAgentStatus(name: string, status: string): void {
    const existing = this.agents.find((a) => a.name === name);
    if (existing?.status === "archived") return;
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
   * Two modes, decided by `parseJumpDate`:
   *  - Date jump: fetch a window of blocks around the target timestamp,
   *    merge into the current chat (so the user's history isn't blown
   *    away), and scroll to the earliest block on or after the target
   *    date. No pulse — date jumps are navigational, not search results.
   *  - Term jump: FTS search over the agent's blocks, merge results into
   *    the chat, scroll to and pulse the top-ranked hit, surface a toast
   *    with the match count. Highlight clears on the next keystroke (see
   *    `ChatInput.onInput`).
   *
   * Pin-to-bottom is explicitly released before mutating state so the
   * auto-scroll effect in `ChatShell` doesn't race the `scrollIntoView`
   * call back down to the latest. If the bottom sentinel is still in
   * view after the jump, the IntersectionObserver will flip it back to
   * `true` on its own.
   */
  async jumpTo(agent: string, arg: string): Promise<void> {
    const trimmed = arg.trim();
    if (!trimmed) {
      this.setToast("Usage: /jump <date|term>", "warn");
      return;
    }
    const ts = parseJumpDate(trimmed);
    const isDateJump = ts !== null;
    const url = isDateJump
      ? `/api/agents/${encodeURIComponent(agent)}/blocks?around_ts=${ts}&before_limit=10&after_limit=40`
      : `/api/agents/${encodeURIComponent(agent)}/blocks?match=${encodeURIComponent(trimmed)}&limit=20`;

    let rawBlocks: BlockRow[];
    try {
      const r = await fetch(url);
      if (!r.ok) {
        this.setToast("Couldn't search this chat.", "warn");
        return;
      }
      const data = (await r.json()) as { blocks: BlockRow[] };
      rawBlocks = data.blocks ?? [];
    } catch (err) {
      this.setToast(
        err instanceof Error ? err.message : "Jump failed.",
        "warn",
      );
      return;
    }

    if (rawBlocks.length === 0) {
      this.setToast(
        isDateJump ? "No chat on that date." : "No matches.",
        "warn",
      );
      return;
    }

    // For date jumps: detect "out of range" — no block falls on or after
    // the target date. Around_ts always returns the closest blocks, so an
    // empty after-range tells us the user jumped past the end of history.
    if (isDateJump) {
      const hasOnOrAfter = rawBlocks.some((b) => b.ts >= (ts as number));
      const hasBefore = rawBlocks.some((b) => b.ts < (ts as number));
      if (!hasOnOrAfter || !hasBefore) {
        // No after-blocks → date is past the end of chat.
        // No before-blocks → date is before any chat. Either way, the
        // window is clipped on one side; tell the user.
        if (!hasOnOrAfter) {
          this.setToast("Date is past the end of this chat.", "warn");
          return;
        }
        // hasOnOrAfter && !hasBefore: this is OK — we just don't have
        // anything earlier. Don't toast; scroll to whatever we got.
      }
    }

    const parsed = parseBlocks(rawBlocks, agent);

    // Find the scroll target BEFORE the merge so we can compute it
    // against the raw response (which preserves FTS rank order for term
    // mode and chronology for date mode).
    let targetId: string | undefined;
    if (isDateJump) {
      // Earliest block on or after the target ts (the user typed a date —
      // they want to land at the start of that day, not in the middle of
      // yesterday's tail).
      const targetTs = ts as number;
      const candidate =
        rawBlocks
          .slice()
          .sort((a, b) => a.ts - b.ts)
          .find(
            (b) =>
              b.ts >= targetTs &&
              (b.role === "user" || b.role === "assistant") &&
              b.kind === "text",
          ) ??
        rawBlocks
          .slice()
          .sort((a, b) => a.ts - b.ts)
          .find((b) => b.role === "user" || b.role === "assistant");
      if (candidate) {
        targetId =
          candidate.role === "user"
            ? userBlockIdForTurn(candidate.turnId)
            : `b_${candidate.blockId}`;
      }
    } else {
      // FTS: matchBlocks returned ORDER BY rank, so the first row is the
      // top-ranked hit. parseBlocks re-sorts by id, which is why we pick
      // the target id from the raw response.
      const top = rawBlocks.find(
        (b) =>
          (b.role === "user" || b.role === "assistant") && b.kind === "text",
      );
      if (top) {
        targetId =
          top.role === "user"
            ? userBlockIdForTurn(top.turnId)
            : `b_${top.blockId}`;
      }
    }

    // Merge parsed into existing messages. Dedup by id; existing entries
    // win so streaming/running statuses survive (a /jump landing mid-turn
    // shouldn't collapse the in-flight bubble's state). Re-sort settled
    // messages by ts; pending bubbles stay at the bottom.
    const byId = new Map<string, ChatMessage>();
    for (const m of this.messages) byId.set(m.id, m);
    for (const m of parsed) if (!byId.has(m.id)) byId.set(m.id, m);
    const all = [...byId.values()];
    const pending = all.filter((m) => m.pending);
    const settled = all.filter((m) => !m.pending);
    settled.sort((a, b) => a.ts - b.ts);

    // Release the bottom pin BEFORE writing the messages array so the
    // length-watching effect in ChatShell sees `pinnedToBottom=false` and
    // skips its auto-scroll-to-bottom. The bottom-sentinel IO will flip
    // it back to true if the user is genuinely at the bottom after the
    // jump (e.g. /jump to a very recent message).
    this.pinnedToBottom = false;
    this.messages = [...settled, ...pending];

    if (targetId) {
      this.scrollNonce += 1;
      this.scrollTarget = { id: targetId, nonce: this.scrollNonce };
      if (!isDateJump) {
        this.highlightedMessageId = targetId;
        const matchCount = rawBlocks.filter(
          (b) =>
            (b.role === "user" || b.role === "assistant") && b.kind === "text",
        ).length;
        this.setToast(
          `${matchCount} match${matchCount === 1 ? "" : "es"}`,
          "info",
        );
      }
    } else if (!isDateJump) {
      // Term mode returned only tool/thinking rows — nothing the user
      // can meaningfully be shown.
      this.setToast("No matches.", "warn");
    }
  }

  startAssistantTurn(turnId: string, agent: string): void {
    this.markInflight(agent, turnId);
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
          m.status === "error" ||
          // Stopping bubbles freeze rendering — the user has explicitly
          // asked the turn to halt and shouldn't see new text grow while
          // we wait for the daemon's terminal turn_done. The bubble's
          // existing text stays; the daemon's eventual turn_done flips
          // the row to its real terminal state.
          m.status === "stopping"
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
    // Safety net for the iterator-error path. The worker now flushes
    // in-flight blocks with a terminal status on catch, but if any tool /
    // thinking bubble slips through (eviction, dropped block-stop, JSONL
    // recovery race), close it here using the turn-level status — never
    // leave a `running` bubble pinned to a turn the daemon has declared
    // done. Assistant text bubbles use the same matching rule they always
    // have.
    for (const m of this.messages) {
      if (m.id !== turnId && m.turnId !== turnId) continue;
      if (m.role === "assistant") {
        if (
          m.status === "complete" ||
          m.status === "aborted" ||
          m.status === "error"
        ) {
          continue;
        }
        m.status = status;
      } else if (m.role === "tool" || m.role === "thinking") {
        if (m.status === "done" || m.status === "error" || m.status === "aborted") {
          continue;
        }
        m.status = status === "complete" ? "done" : status;
      }
    }
    // Inflight-slot cleanup is delegated to `clearInflightForTurn` so
    // applyEvent's `turn_done` / `error` cases can clear the slot for
    // non-focused agents without going through the message-walking
    // path here (which only ever touches focused-agent messages).
    this.clearInflightForTurn(turnId);
  }

  /**
   * Clear any per-agent inflight slot whose value matches `turnId`.
   * Preserves the requestStop race invariant — if a mail-driven T2
   * started on the same agent before T1's terminal event landed, the
   * slot was already overwritten to T2 and won't be clobbered here.
   */
  clearInflightForTurn(turnId: string): void {
    for (const [agent, slotTurnId] of Object.entries(this.inflightTurnIdByAgent)) {
      if (slotTurnId === turnId) this.inflightTurnIdByAgent[agent] = null;
    }
  }

  /* ------------ FRI-12: Resend / Resume helpers ------------ */

  /** Find the original user text for a turn, when present in the
   *  currently-loaded messages. Used by the error bubble's CTAs to know
   *  whether Resend has anything to send. */
  private originalUserTextForTurn(turnId: string): string | null {
    // The user-block id is stable across canonical id schemes:
    // `userBlockIdForTurn(turnId)` for SSE-materialized rows, and a
    // pending-bubble's id is `p_<queueId>` (different — won't collide).
    const id = userBlockIdForTurn(turnId);
    const m = this.messages.find((x) => x.id === id);
    if (m && m.role === "user" && typeof m.text === "string" && m.text.trim().length > 0) {
      return m.text;
    }
    return null;
  }

  canResendTurn(turnId: string | undefined): boolean {
    if (!turnId) return false;
    if (this.originalUserTextForTurn(turnId) === null) return false;
    // Resend always queues a fresh turn — no in-flight gating needed
    // (sendQueue handles its own concurrency).
    return true;
  }

  canResumeTurn(turnId: string | undefined, errorCode: string | undefined): boolean {
    if (!turnId) return false;
    if (this.originalUserTextForTurn(turnId) === null) return false;
    // 401 / 403 / 400 / 404 won't get better on retry — re-dispatching
    // the same prompt to the same model with the same auth produces
    // the same error.
    if (errorCode === "unauthorized" || errorCode === "forbidden") return false;
    if (errorCode === "bad_request" || errorCode === "not_found") return false;
    // Disable while any other turn is in flight on the focused agent.
    if (this.inflightTurnId !== null) return false;
    return true;
  }

  /**
   * Recover the original user prompt for a failed turn and queue it as a
   * fresh send. The new turn gets a new turn_id (the daemon mints one);
   * the error bubble stays under the failed turn_id and the new turn
   * appears below it.
   */
  resendUserText(turnId: string): void {
    const text = this.originalUserTextForTurn(turnId);
    if (text === null) {
      this.setToast("Cannot resend — original message not found.", "warn");
      return;
    }
    // Mirror ChatInput's send path: enqueue, push the pending bubble,
    // then flush. The optimistic bubble pins to the bottom until the
    // daemon's `turn_started` confirms; on confirm, `confirmPending`
    // re-keys it to its canonical user-block id.
    const item = sendQueue.enqueue({ agent: this.focusedAgent, text });
    this.addUser(text, { queueId: item.id });
    void sendQueue.flush().then((result) => {
      for (const s of result.sent) {
        this.confirmPending(s.queueId, s.turnId);
        this.markInflight(this.focusedAgent, s.turnId);
      }
      for (const qid of result.failed) this.markPendingFailed(qid);
      for (const qid of result.retrying) this.markPendingRetrying(qid);
    });
  }

  /**
   * Re-dispatch the original prompt under the SAME turn_id so the retry's
   * blocks visually group with the error bubble. Hits the dedicated
   * `/api/chat/turn/:turnId/resume` endpoint; the daemon looks up the
   * original user block server-side (so we don't have to send the text
   * back over the wire) and reuses dispatchTurn.
   */
  async resumeTurn(turnId: string): Promise<void> {
    try {
      const r = await fetchWithTimeout(
        `/api/chat/turn/${encodeURIComponent(turnId)}/resume`,
        { method: "POST", timeoutMs: 10_000 },
      );
      if (!r.ok) {
        let msg = `Resume failed (${r.status})`;
        try {
          const body = (await r.json()) as { message?: string; error?: string };
          if (body.message) msg = `Resume failed: ${body.message}`;
          else if (body.error) msg = `Resume failed: ${body.error}`;
        } catch {
          // ignore — keep the generic message
        }
        this.setToast(msg, "warn");
      }
      // Success path: the daemon's `turn_started` SSE will arrive next
      // and populate inflightTurnId. Nothing else to do here.
    } catch {
      this.setToast("Resume failed (network).", "warn");
    }
  }

  /**
   * Mark the assistant bubble for `turnId` as `stopping`. Used by the
   * Stop button before firing the abort POST so the UI immediately
   * reflects that the user has requested a halt — without lying about
   * whether the daemon has actually stopped yet.
   *
   * The bubble's status flips streaming → stopping; appendDelta then
   * freezes further text growth on it. When the daemon's `turn_done`
   * eventually lands, finishTurn overwrites status with the truthful
   * terminal state (typically `aborted`, occasionally `complete` if the
   * model's last token already shipped before the abort took effect).
   *
   * Idempotent: re-stopping a turn that's already stopping is a no-op.
   * Returns true when the bubble was found and marked, false when the
   * turn has already finalized or was never registered (the caller can
   * still fire the POST defensively but shouldn't expect UI feedback).
   *
   * Race coverage:
   *   - Mail starts T2 mid-stop of T1: T1 stays stopping, T2 starts as
   *     streaming with its own bubble. Each finishTurn handles its own
   *     turn id; finishTurn(T1) clears inflightTurnId only if it still
   *     equals T1 (it doesn't — T2 overwrote it on turn_started), so
   *     T2's busy state survives.
   *   - Daemon's turn_done arrives before requestStop wins the lookup
   *     (already finalized): returns false; the abort POST will return
   *     `aborted: false` from the server's findAgentByTurnId.
   */
  requestStop(turnId: string): boolean {
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      if (m.id !== turnId && m.turnId !== turnId) continue;
      if (
        m.status === "complete" ||
        m.status === "aborted" ||
        m.status === "error"
      ) {
        return false;
      }
      // Already stopping: caller can still fire the POST again but the
      // UI is already in the right place. Return true so the caller's
      // "I requested stop" branch keeps running.
      if (m.status === "stopping") return true;
      m.status = "stopping";
      return true;
    }
    return false;
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
      if (latestTurnId) this.markInflight(agent, latestTurnId);
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
    // F3-C: persist after each advance so a page reload doesn't lose the
    // cursor and re-count replayed events. saveJSON is synchronous + small;
    // the volume of accepted events is low enough that this isn't hot.
    saveJSON(ChatState.LAST_SEQ_KEY, this.lastSeqByAgent);
    return true;
  }

  applyEvent(event: WireEvent): void {
    if (!this.acceptEvent(event)) return;

    switch (event.type) {
      case "turn_started": {
        // Archived agents can't legitimately have an inflight turn.
        // A ring-buffer replay's stale turn_started for an archived
        // agent would otherwise set inflightTurnId and surface a "Stop"
        // button on a frozen chat.
        const a = this.agents.find((x) => x.name === event.agent);
        if (a?.status === "archived") break;
        // FRI-12: write per-agent regardless of focus. The dashboard
        // pages between agents but the daemon's wedge state is per-
        // agent — switching focus must not leak agent A's stuck
        // inflight onto agent B's input bar.
        this.markInflight(event.agent, event.turn_id);
        break;
      }
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
      case "block_meta_update":
        if (event.agent !== this.focusedAgent) break;
        this.handleBlockMetaUpdate(event);
        break;
      case "block_reload":
        if (event.agent !== this.focusedAgent) break;
        // Daemon's JSONL recovery scan inserted/updated rows for this agent
        // (FIX_FORWARD 1.3). Re-seed history so the dashboard mirrors the
        // canonical blocks table.
        void this.loadAgentTurns(event.agent);
        break;
      case "turn_done":
        // FRI-12: always clear the per-agent inflight slot for this
        // turn — quarantine of inflight state is global state and must
        // not be gated on focus, otherwise switching to a non-focused
        // agent leaks the wedge indicator. The bubble-status walk
        // below stays focus-gated because chat.messages only holds the
        // focused agent's bubbles.
        this.clearInflightForTurn(event.turn_id);
        if (event.agent !== this.focusedAgent) break;
        this.finishTurn(event.turn_id, event.status);
        break;
      case "error":
        // Same per-agent quarantine: clear the slot for this turn even
        // when the event is for a non-focused agent.
        if (event.turn_id) this.clearInflightForTurn(event.turn_id);
        if (event.agent !== this.focusedAgent) break;
        if (event.turn_id) this.finishTurn(event.turn_id, "error");
        break;
      case "agent_lifecycle":
        if (event.event === "spawn") {
          this.upsertAgent(event.agent, {
            type: event.agentType,
            status: "working",
          });
        } else if (event.event === "archive") {
          // Mark as archived; row stays in chat.agents so "Show archived"
          // can surface it. Sessions persist as history forever.
          this.upsertAgent(event.agent, { status: "archived" });
        } else if (event.event === "complete") {
          // F2-A: worker exited cleanly. The daemon already flipped
          // status to idle (F1-A); reflect it locally so tabs that
          // missed the prior agent_status: idle don't drift. upsertAgent
          // refuses to create with type="unknown" (F2-B), so a stray
          // complete for an unknown agent is a safe no-op — the next
          // /api/agents poll will surface it.
          //
          // Archived is terminal — see applyAgentStatus comment. A
          // ring-buffer replay's `complete` for an already-archived
          // agent must not flip status back to idle.
          const existing = this.agents.find((a) => a.name === event.agent);
          if (existing?.status === "archived") break;
          this.upsertAgent(event.agent, { status: "idle" });
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
        // F3-B (PR C): we used to bump unread here as a faster nudge
        // before the recipient's assistant reply landed. That produced
        // double-counts (mail_delivered + later assistant agent_message
        // → two badges per logical event). The assistant reply is the
        // signal that warrants a badge; until then the chat shows
        // nothing the user can act on. Intentional no-op here.
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
    kind: "text" | "thinking" | "tool_use" | "tool_result" | "error";
    turn_id: string;
    tool?: { id: string; name: string };
    ts: number;
  }): void {
    // FRI-12: error blocks ship as a fused start+complete pair from the
    // daemon. We materialize the bubble on `block_complete` only — the
    // start carries no useful metadata and would push an empty placeholder.
    if (event.kind === "error") return;
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
        turnId: event.turn_id,
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
        turnId: event.turn_id,
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
    kind: "text" | "thinking" | "tool_use" | "tool_result" | "error";
    content_json: string;
    status: "complete" | "aborted" | "error" | "queued";
    turn_id: string;
    role: string;
    source: string | null;
    ts: number;
  }): void {
    if (event.kind === "error") {
      const errPayload = parseErrorContent(event.content_json);
      const id = `e_${event.block_id}`;
      // Idempotent — ring-buffer replay or reload-mid-error must not double-add.
      const existing = this.messages.find((m) => m.id === id);
      if (existing) {
        existing.errorCode = errPayload.code;
        existing.errorHeadline = errPayload.headline;
        existing.httpStatus = errPayload.httpStatus;
        existing.retryAfterSeconds = errPayload.retryAfterSeconds;
        existing.requestId = errPayload.requestId;
        existing.rawErrorMessage = errPayload.rawMessage;
        return;
      }
      this.messages.push({
        id,
        role: "assistant",
        kind: "error",
        text: errPayload.headline,
        status: "error",
        agent: this.focusedAgent,
        turnId: event.turn_id,
        ts: event.ts,
        errorCode: errPayload.code,
        errorHeadline: errPayload.headline,
        httpStatus: errPayload.httpStatus,
        retryAfterSeconds: errPayload.retryAfterSeconds,
        requestId: errPayload.requestId,
        rawErrorMessage: errPayload.rawMessage,
      });
      return;
    }
    const parsed = parseBlockContent(event.content_json);
    if (event.kind === "text") {
      if (isNoResponseSentinel(event.role, parsed.text)) return;
      const id =
        event.role === "user"
          ? userBlockIdForTurn(event.turn_id)
          : `b_${event.block_id}`;
      const mappedStatus: ChatMessage["status"] =
        event.status === "complete"
          ? "complete"
          : event.status === "aborted"
            ? "aborted"
            : event.status === "queued"
              ? "queued"
              : "error";
      for (const m of this.messages) {
        if (m.id !== id) continue;
        if (typeof parsed.text === "string") m.text = parsed.text;
        m.status = mappedStatus;
        // Backfill source/fromAgent if a prior block_start mounted the row
        // without them. recordUserBlock for mail emits only block_complete
        // (no block_start), so today this path is not hit for mail; the
        // defensive backfill protects against future churn.
        if (m.source === undefined && event.source) {
          m.source = event.source as ChatMessage["source"];
        }
        if (m.fromAgent === undefined && parsed.from_agent) {
          m.fromAgent = parsed.from_agent;
        }
        if (m.attachments === undefined && parsed.attachments) {
          m.attachments = parsed.attachments;
        }
        // Hand off the turn id and block id so cancelQueued and the
        // cancel-X affordance can target this bubble even after
        // `confirmPending` has cleared the optimistic queueId. block_id
        // also lets handleBlockMetaUpdate locate the bubble directly.
        if (!m.turnId && event.turn_id) m.turnId = event.turn_id;
        if (!m.blockId && event.block_id) m.blockId = event.block_id;
        return;
      }
      // Late mount: block_start was evicted from the ring (or — for mail
      // — was never emitted in the first place).
      const role = event.role === "user" ? "user" : "assistant";
      this.messages.push({
        id,
        role,
        text: parsed.text ?? "",
        status: mappedStatus,
        agent: this.focusedAgent,
        turnId: event.turn_id,
        blockId: event.block_id,
        ts: event.ts,
        source: (event.source as ChatMessage["source"]) ?? undefined,
        fromAgent: parsed.from_agent,
        mailMeta: extractMailMeta(parsed),
        attachments: parsed.attachments,
      });
      return;
    }
    if (event.kind === "thinking") {
      const id = `th_${event.block_id}`;
      // For thinking blocks, 'complete' (and the un-aborted retry path)
      // both surface as the user-visible "done" state. Terminal abort/error
      // — emitted by the worker's tear-down on iterator failure or
      // `api_retry` — gets the matching state so the bubble isn't left
      // spinning.
      const status: ChatMessage["status"] =
        event.status === "aborted"
          ? "aborted"
          : event.status === "error"
            ? "error"
            : "done";
      for (const m of this.messages) {
        if (m.id !== id) continue;
        if (typeof parsed.text === "string") m.text = parsed.text;
        m.status = status;
        return;
      }
      this.messages.push({
        id,
        role: "thinking",
        text: parsed.text ?? "",
        status,
        blockId: event.block_id,
        turnId: event.turn_id,
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
        // A tool_use that completes with aborted/error never gets a
        // tool_result follow-up to flip the bubble off "running" — honor
        // the terminal status here.
        if (event.status === "aborted") m.status = "aborted";
        else if (event.status === "error") m.status = "error";
        return;
      }
      // Late mount.
      const status: ChatMessage["status"] =
        event.status === "aborted"
          ? "aborted"
          : event.status === "error"
            ? "error"
            : "running";
      this.messages.push({
        id,
        role: "tool",
        text: "",
        status,
        toolId,
        toolName: parsed.name ?? "",
        input: parsed.input,
        turnId: event.turn_id,
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

  /**
   * Late-binding update to a previously-emitted block. The daemon uses this
   * to flip a queued user block to `complete` with a fresh `ts` once the
   * worker actually dispatches the prompt (or to `aborted` when the cancel
   * endpoint deletes the row out from under any other tab still watching).
   *
   * Aborted status drops the bubble entirely — the row is gone DB-side, so
   * keeping it around as an "aborted user message" would surface a ghost.
   */
  private handleBlockMetaUpdate(event: {
    block_id: string;
    turn_id: string;
    status?: "streaming" | "complete" | "aborted" | "error" | "queued";
    ts?: number;
  }): void {
    if (event.status === "aborted") {
      this.messages = this.messages.filter(
        (m) =>
          m.blockId !== event.block_id &&
          // userBlockIdForTurn keys also serve as a fallback when the row
          // was synthesized late (no block_id captured on the bubble).
          m.id !== userBlockIdForTurn(event.turn_id),
      );
      return;
    }
    for (const m of this.messages) {
      const matches =
        m.blockId === event.block_id ||
        m.id === userBlockIdForTurn(event.turn_id);
      if (!matches) continue;
      if (event.status) {
        m.status =
          event.status === "complete"
            ? "complete"
            : event.status === "queued"
              ? "queued"
              : event.status === "error"
                ? "error"
                : event.status === "streaming"
                  ? "streaming"
                  : m.status;
      }
      if (typeof event.ts === "number") m.ts = event.ts;
      return;
    }
  }

  /**
   * Yank a queued user-chat turn out of the daemon's `nextPrompts` FIFO
   * before the worker dispatches it. Returns the recovered prompt text so
   * the caller (ChatInput's cancel-X handler) can stuff it back into the
   * textarea. Removes the bubble locally on success; on failure leaves it
   * in place so the user can try again or wait for the dispatch.
   *
   * 409 means the worker drained the queue between bubble render and
   * click — treat that as "too late" and leave the bubble; the next
   * turn_started event will flip it to streaming anyway.
   */
  async cancelQueued(turnId: string): Promise<string | null> {
    try {
      const r = await fetchWithTimeout(`/api/chat/turn/${turnId}/queued`, {
        method: "DELETE",
        timeoutMs: 5_000,
      });
      if (!r.ok) return null;
      const data = (await r.json().catch(() => ({}))) as { text?: string };
      this.messages = this.messages.filter(
        (m) => m.turnId !== turnId || m.role !== "user",
      );
      return typeof data.text === "string" ? data.text : "";
    } catch {
      return null;
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
  /** Mail-source block extras (see daemon/agent/lifecycle.ts
   *  recordUserBlock). */
  mail_id?: number;
  mail_subject?: string | null;
  mail_type?: string;
  mail_priority?: string;
  mail_thread_id?: string | null;
  mail_ts?: number;
  /** user_chat blocks for paste/drop/file-pick sends carry the attachment
   *  metadata the daemon persisted alongside the text. Reload reads this
   *  back so the bubble's image thumb / file chip survives across page
   *  loads (FRI-6). */
  attachments?: Array<{ sha256: string; filename: string; mime: string }>;
}

function parseBlockContent(contentJson: string): ParsedBlockContent {
  try {
    return JSON.parse(contentJson) as ParsedBlockContent;
  } catch {
    return {};
  }
}

/** Parsed shape of a `kind="error"` block's content_json. Mirrors the
 *  daemon-side `ErrorBlockPayload` (services/daemon/src/agent/lifecycle.ts).
 *  Defensive defaults so a malformed/legacy row still renders something. */
export interface ParsedErrorContent {
  code: string;
  headline: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  requestId?: string;
  rawMessage: string;
}

function parseErrorContent(contentJson: string): ParsedErrorContent {
  try {
    const raw = JSON.parse(contentJson) as Partial<ParsedErrorContent>;
    return {
      code: typeof raw.code === "string" ? raw.code : "unknown",
      headline:
        typeof raw.headline === "string" && raw.headline.length > 0
          ? raw.headline
          : "Something went wrong",
      httpStatus: typeof raw.httpStatus === "number" ? raw.httpStatus : undefined,
      retryAfterSeconds:
        typeof raw.retryAfterSeconds === "number" && raw.retryAfterSeconds >= 0
          ? raw.retryAfterSeconds
          : undefined,
      requestId: typeof raw.requestId === "string" ? raw.requestId : undefined,
      rawMessage: typeof raw.rawMessage === "string" ? raw.rawMessage : contentJson,
    };
  } catch {
    return { code: "unknown", headline: "Something went wrong", rawMessage: contentJson };
  }
}

/** Pull the mail metadata out of a parsed content_json, if present. The
 *  daemon writes these fields only for `source='mail'` blocks; older mail
 *  rows persisted before the schema gained these fields will return
 *  undefined and MailBlock will fall back to a header-only view. */
function extractMailMeta(
  parsed: ParsedBlockContent,
): ChatMessage["mailMeta"] | undefined {
  if (typeof parsed.mail_id !== "number") return undefined;
  return {
    id: parsed.mail_id,
    subject: parsed.mail_subject ?? null,
    type: parsed.mail_type ?? "message",
    priority: parsed.mail_priority ?? "normal",
    threadId: parsed.mail_thread_id ?? null,
    ts: parsed.mail_ts ?? 0,
  };
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
      if (isNoResponseSentinel(b.role, parsed.text)) continue;
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
          ? b.status === "queued"
            ? "queued"
            : "complete"
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
        blockId: b.blockId,
        ts: b.ts,
        source: (b.source as ChatMessage["source"]) ?? undefined,
        fromAgent: parsed.from_agent,
        mailMeta: extractMailMeta(parsed),
        attachments: parsed.attachments,
      });
    } else if (b.kind === "thinking") {
      // Same shape for thinking blocks. `handleBlockDelta` gates on
      // `m.status === "running"` for thinking; preserve "running"
      // for streaming rows so reload-mid-turn deltas append.
      const status: ChatMessage["status"] =
        b.status === "streaming"
          ? "running"
          : b.status === "aborted"
            ? "aborted"
            : b.status === "error"
              ? "error"
              : "done";
      out.push({
        id: `th_${b.blockId}`,
        role: "thinking",
        text: parsed.text ?? "",
        status,
        blockId: b.blockId,
        turnId: b.turnId,
        ts: b.ts,
      });
    } else if (b.kind === "tool_use") {
      const toolId = parsed.tool_use_id ?? b.blockId;
      // Dedup duplicate tool_use rows for the same id — JSONL replay
      // artifacts and refork retries can both produce them.
      if (toolByToolId.has(toolId)) continue;
      const status: ChatMessage["status"] =
        b.status === "aborted"
          ? "aborted"
          : b.status === "error"
            ? "error"
            : "running";
      const msg: ChatMessage = {
        id: `t_${toolId}`,
        role: "tool",
        text: "",
        status,
        toolId,
        toolName: parsed.name ?? "",
        input: parsed.input,
        turnId: b.turnId,
        ts: b.ts,
      };
      out.push(msg);
      toolByToolId.set(toolId, msg);
    } else if (b.kind === "error") {
      // FRI-12: synthetic error bubble persisted by the daemon when the
      // SDK throws or the stop force-kill safety net fires. Mirror the
      // SSE `block_complete` materialization shape so reload-mid-error
      // and live-error converge on the same id (e_<blockId>).
      const errPayload = parseErrorContent(b.contentJson);
      out.push({
        id: `e_${b.blockId}`,
        role: "assistant",
        kind: "error",
        text: errPayload.headline,
        status: "error",
        agent,
        turnId: b.turnId,
        ts: b.ts,
        errorCode: errPayload.code,
        errorHeadline: errPayload.headline,
        httpStatus: errPayload.httpStatus,
        retryAfterSeconds: errPayload.retryAfterSeconds,
        requestId: errPayload.requestId,
        rawErrorMessage: errPayload.rawMessage,
      });
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
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (trimmed === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
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

