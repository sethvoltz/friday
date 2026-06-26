import type { BlockKind, WireEvent } from "@friday/shared";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { fetchWithTimeout } from "../util/fetch-with-timeout";
import { initialPageSize } from "../util/page-size";
import { resolveSendTargetAgent } from "../util/send-target";
import { randomUUID } from "../util/uuid";
import type { SendUserMessageOutcome } from "./mutator-result";
import { KEYS, loadJSON, removeKey, saveJSON } from "./persistent";
import {
  filterRowsToCurrentSession,
  mergeBubbles,
  mergeZeroSnapshot,
  oldestBlockCursor,
  overlayKey,
  parseBlocks,
  pruneConverged,
  reconcileCanceled,
  reconcileComplete,
  userBlockIdForTurn,
  userBubbleAlreadyLanded,
  type AgentInfo,
  type BlockRow,
  type ChatMessage,
  type OverlayKey,
  type ReconcileSnapshot,
  type ZeroBlocksRow,
} from "./bubble-convergence";

// Re-export the bubble-convergence presentation core's public surface so
// existing importers — zero.svelte.ts, the Chat components, CommandPalette,
// and the chat.test.ts dynamic imports — keep resolving these symbols
// against "./chat.svelte" after the convergence-core extraction.
export {
  dropSupersededNoResponseSafetyNet,
  filterRowsToCurrentSession,
  noResponseIdForTurn,
  oldestBlockCursor,
  overlayKey,
  parseBlocks,
  PENDING_SESSION_SENTINEL,
  userBlockIdForTurn,
  zeroBlockRowToBlockRow,
} from "./bubble-convergence";
export type {
  AgentInfo,
  BlockRow,
  ChatMessage,
  OverlayKey,
  ParsedErrorContent,
  ZeroBlocksRow,
} from "./bubble-convergence";

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

/**
 * FRI-139 review-6: lifecycle event for transport-failure fallback
 * timers. Structured `console.debug` so dashboard log capture / browser
 * devtools can grep `[chat.transport-failure]` and reconstruct
 * arm/fire/cancel cadence across a session. The reviewer asked for
 * this so the 30s threshold can be tuned from real data; surfacing
 * the cadence into `~/.friday/logs/dashboard-*.jsonl` would require a
 * dedicated diag endpoint, which is out of scope for this PR — for now
 * the events are visible in devtools and forwarded by the
 * `window.error` / `unhandledrejection` plumbing only for the
 * mark-failed leg (where they typically matter).
 *
 * Event vocabulary:
 *   - `arm`         — fallback timer scheduled; payload includes `delayMs`.
 *   - `cancel`      — `clearTransportFailureTimer` ran and removed the timer.
 *   - `fire`        — timer expired AND the optimistic entry still
 *                     exists (about to flip failed).
 *   - `fire-stale`  — timer expired but the optimistic was already gone
 *                     (canonical row landed in the window — the
 *                     happy-path-after-WS-hiccup case).
 *   - `mark-failed` — `markPendingFailed` flipped `failed:true` for
 *                     the entry. Fired either by app-error/no-zero
 *                     (immediate) or by the timer routing through it.
 */
function transportFailureLog(
  event: "arm" | "cancel" | "fire" | "fire-stale" | "mark-failed",
  queueId: string,
  extra?: Record<string, unknown>,
): void {
  if (typeof console === "undefined") return;
  const payload = { event, queueId, ts: Date.now(), ...(extra ?? {}) };
  console.debug("[chat.transport-failure]", payload);
}

/**
 * Live overlay entry for an in-flight assistant / tool / thinking block.
 *
 * Streaming-mutable fields (`text`, `status`, `input`, `output`,
 * `inputPartialJson`, `toolName`) are declared with `$state`. Each
 * instance carries its own per-field reactivity, so `entry.text += delta`
 * fires a fine-grained subscription on `entry.text` without invalidating
 * the parent `messages` derivation — the SvelteMap holding entries
 * tracks set/delete/clear, not value-object field mutations. This is the
 * design property that keeps streaming-text latency at one paint frame
 * even on a long session: per-delta work is O(1), bounded by the bubble's
 * own text-node update.
 *
 * Implements `ChatMessage` so the bubble component renders entries
 * interchangeably with canonical row-derived ChatMessage objects.
 *
 * `sessionId` is captured at construction from the agent's current
 * session. The `chat.messages` derivation filters overlay entries by
 * `entry.sessionId === currentAgentSessionId`, so a `/clear` (which
 * nulls sessionId) naturally hides leftover in-flight entries without
 * imperative cleanup. A `$effect` watching `agents[name].sessionId`
 * prunes stale entries in the background.
 */
export class StreamingEntry implements ChatMessage {
  readonly id: string;
  readonly role: "assistant" | "tool" | "thinking";
  readonly agent: string;
  readonly ts: number;
  readonly turnId: string;
  readonly blockId: string;
  readonly sessionId: string | null;
  readonly toolId?: string;
  readonly source?: ChatMessage["source"];

  // Streaming-mutable, each field per-instance reactive.
  text = $state("");
  status = $state<ChatMessage["status"]>("streaming");
  toolName = $state<string | undefined>(undefined);
  input = $state<unknown>(undefined);
  output = $state<string | undefined>(undefined);
  inputPartialJson = $state<string | undefined>(undefined);
  isRedacted = $state(false);

  constructor(init: {
    id: string;
    role: "assistant" | "tool" | "thinking";
    agent: string;
    ts: number;
    turnId: string;
    blockId: string;
    sessionId: string | null;
    toolId?: string;
    source?: ChatMessage["source"];
    initialStatus?: ChatMessage["status"];
    initialText?: string;
    initialToolName?: string;
    isRedacted?: boolean;
  }) {
    this.id = init.id;
    this.role = init.role;
    this.agent = init.agent;
    this.ts = init.ts;
    this.turnId = init.turnId;
    this.blockId = init.blockId;
    this.sessionId = init.sessionId;
    this.toolId = init.toolId;
    this.source = init.source;
    if (init.initialStatus) this.status = init.initialStatus;
    if (init.initialText) this.text = init.initialText;
    if (init.initialToolName) this.toolName = init.initialToolName;
    if (init.isRedacted) this.isRedacted = init.isRedacted;
  }
}

/**
 * Optimistic overlay entry for a user bubble that hasn't yet been
 * confirmed by the daemon's mutator path. Renders pinned to the bottom
 * of the chat with a "queued" / "sending" affordance until the
 * canonical row arrives via Zero (matching `userBlockIdForTurn(turnId)`
 * or the pre-minted `queueBlockId`) and the entry is dropped from the
 * overlay.
 *
 * Same reactivity contract as StreamingEntry: mutable status flags are
 * `$state`, the SvelteMap doesn't proxy stored values, the parent
 * derivation only re-runs on set/delete.
 */
export class OptimisticEntry implements ChatMessage {
  readonly id: string;
  readonly role = "user" as const;
  readonly agent: string;
  readonly ts: number;
  readonly turnId: string;
  readonly sessionId: string | null;
  readonly text: string;
  readonly source?: ChatMessage["source"];
  readonly queueId?: string;
  readonly attachments?: ChatMessage["attachments"];

  status = $state<ChatMessage["status"]>("complete");
  pending = $state(true);
  failed = $state(false);

  constructor(init: {
    id: string;
    agent: string;
    ts: number;
    turnId: string;
    sessionId: string | null;
    text: string;
    source?: ChatMessage["source"];
    queueId?: string;
    attachments?: ChatMessage["attachments"];
    initialStatus?: ChatMessage["status"];
    initialPending?: boolean;
  }) {
    this.id = init.id;
    this.agent = init.agent;
    this.ts = init.ts;
    this.turnId = init.turnId;
    this.sessionId = init.sessionId;
    this.text = init.text;
    this.source = init.source;
    this.queueId = init.queueId;
    this.attachments = init.attachments;
    if (init.initialStatus) this.status = init.initialStatus;
    if (init.initialPending !== undefined) this.pending = init.initialPending;
  }
}

export class ChatState {
  /**
   * Legacy bucket for canonical Zero-replicated bubbles + a handful of
   * residual imperative writers that haven't moved to an overlay (sys_<ts>
   * slash-command bubbles via pushLocal; the test-only startAssistantTurn
   * / appendDelta / pushTool / pushThinking / etc. helpers; reload-mid-
   * stream rows that landed at status='streaming' from Zero before SSE
   * caught up — those deltas continue to route via handleBlockDelta's
   * legacy fallback because no overlay entry exists for them yet).
   *
   * Lifecycle ranks: streaming / optimistic overlays own the in-flight
   * phase (per-instance $state reactivity); legacy owns the canonical
   * (terminal) phase. The `messages` derivation merges legacy + overlay
   * with overlay shadowing on id collision.
   *
   * `set messages(v)` writes here so test fixtures (`chat.messages =
   * [...]`) keep working.
   */
  #legacyMessages = $state<ChatMessage[]>([]);
  agents = $state<AgentInfo[]>([]);

  /**
   * Live overlay for in-flight assistant / tool / thinking blocks. Keyed
   * by `overlayKey(agent, msg.id)`. Entries are added on SSE block_start,
   * mutated in place on block_delta (field-level $state reactivity), and
   * removed by block_canceled or by the `pruneConvergedStreamingOverlay`
   * sweep that runs on each applyZeroBlocks once the canonical row
   * replicates at terminal status.
   */
  streaming = new SvelteMap<OverlayKey, StreamingEntry>();

  /**
   * Optimistic overlay for user bubbles that haven't yet been confirmed
   * by Zero. addUser populates it with a `pending_<uuid>` id;
   * confirmPending drops the overlay entry and pushes the canonical
   * bubble into legacy at `userBlockIdForTurn(turn_id)` (the canonical
   * Zero row that lands moments later dedups by id in applyZeroBlocks's
   * merge).
   */
  optimistic = new SvelteMap<OverlayKey, OptimisticEntry>();

  /**
   * Derived chat view for the focused agent: legacy + streaming overlay
   * + optimistic overlay, merged with overlay shadowing on id collision.
   * Overlay entries are filtered by `entry.agent === focused &&
   * entry.sessionId === currentSessionId` so `/clear` (which nulls the
   * agent's sessionId at the daemon) hides leftover in-flight entries
   * with no imperative sweep. Legacy entries are filtered by agent tag —
   * structural cross-agent isolation, replacing the broken
   * loadAgentTurns reset.
   *
   * Reactivity contract: per-entry `$state` fields on StreamingEntry /
   * OptimisticEntry fire fine-grained subscriptions on `entry.text +=
   * delta` etc. WITHOUT re-running this derivation. The derivation
   * re-runs only on structural changes (map set/delete, legacy bucket
   * shape change, focusedAgent / agents flip). Hot-path streaming
   * latency stays at one paint frame even on long sessions.
   */
  #derivedMessages = $derived.by<ChatMessage[]>(() => {
    // Rune reads stay in the shell; the merge is the pure read-time core.
    // `streaming.values()` / `optimistic.values()` are iterated synchronously
    // inside `mergeBubbles` (during this derivation), so the SvelteMap
    // structural dependency is registered here. `mergeBubbles` reads only
    // identity fields off the entries, so per-delta `$state` mutations don't
    // re-run this derivation (see the reactivity contract above).
    const focused = this._focusedAgent;
    const agentRow = this.agents.find((a) => a.name === focused);
    const sid = agentRow?.sessionId ?? null;
    return mergeBubbles(this.#legacyMessages, this.streaming.values(), this.optimistic.values(), {
      agent: focused,
      sessionId: sid,
    });
  });

  /**
   * Public read API: the focused agent's chat bubbles. The setter writes
   * the legacy bucket so test fixtures (`chat.messages = [...]`) keep
   * working; the getter returns the derived view that merges in overlay
   * entries scoped to the focused agent + current session.
   */
  get messages(): ChatMessage[] {
    return this.#derivedMessages;
  }
  set messages(v: ChatMessage[]) {
    this.#legacyMessages = v;
  }

  /**
   * Imperative append to the legacy bucket. Used by callers that need
   * to push a transient bubble (slash-command sys_<ts> errors in
   * ChatInput.svelte; test fixtures setting up seed state) but don't
   * have an overlay to write to. Auto-stamps the focused agent when
   * the caller didn't set one so the derivation's per-agent filter
   * sees an explicit owner.
   */
  pushLocal(msg: ChatMessage): void {
    this.#legacyMessages.push(msg.agent ? msg : { ...msg, agent: this._focusedAgent });
  }

  /**
   * Instrumentation backing field (FRI-72). The public `focusedAgent`
   * getter/setter wraps this so every write logs prev/next + URL +
   * stack — catches the "send went to the wrong agent" leak the next
   * time it happens. Direct $state would be reactive but invisible to
   * us; the wrapper preserves reactivity while adding the trace.
   */
  private _focusedAgent = $state("friday");
  /** Phase 5: registered by sse.svelte.ts (via `bindFocusChange`)
   *  so chat.svelte.ts can ping the SSE store on focus switch
   *  without a static circular import. */
  #onFocusChange: (() => void) | null = null;
  bindFocusChange(cb: () => void): void {
    this.#onFocusChange = cb;
  }
  get focusedAgent(): string {
    return this._focusedAgent;
  }
  set focusedAgent(value: string) {
    const changed = this._focusedAgent !== value;
    this._focusedAgent = value;
    // Phase 5: per-agent SSE channel. On focus switch, fire the
    // registered SSE reopen hook (registered by sse.svelte.ts at
    // startSSE time) so the next reconnect carries `?agent=<new>`
    // and the daemon scopes its replay to the new turn lifecycle.
    // The hook indirection avoids a chat→sse static import cycle.
    if (changed && this.#onFocusChange) this.#onFocusChange();
  }
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
  /**
   * True when the focused agent's `status` is `'working'` in the DB/Zero
   * snapshot. Complements `inflightTurnId` for cases where local ephemeral
   * state was never set or was lost (page refresh, mail-triggered turns).
   * The chat animation and the no-response suppression both read this so
   * they stay accurate regardless of how the turn was initiated.
   */
  get focusedAgentIsWorking(): boolean {
    return this.agents.some((a) => a.name === this.focusedAgent && a.status === "working");
  }
  /** True when a thinking block is actively running — StreamingBall renders inside ThinkingBlock. */
  get ballInThinking(): boolean {
    if (!this.focusedAgentIsWorking) return false;
    return this.messages.some((m) => m.role === "thinking" && m.status === "running");
  }
  get toolIsRunning(): boolean {
    if (!this.focusedAgentIsWorking) return false;
    return this.messages.some((m) => m.role === "tool" && m.status === "running");
  }
  /** True when an assistant text block is streaming and no thinking block or tool is running. */
  get ballInText(): boolean {
    if (!this.focusedAgentIsWorking) return false;
    if (this.ballInThinking) return false;
    if (this.toolIsRunning) return false;
    return this.messages.some((m) => m.role === "assistant" && m.status === "streaming");
  }
  /** True when the agent is working but no streaming/running block has arrived yet. */
  get ballStandalone(): boolean {
    if (!this.focusedAgentIsWorking) return false;
    if (this.toolIsRunning) return false;
    return !this.ballInThinking && !this.ballInText;
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

  /**
   * Sliding-window DOM virtualization cursor. `null` means "follow
   * the live tail" (windowEnd derives to `allMessages.length`, which
   * grows reactively as new messages arrive). A `{agent, end}` value
   * means the user has explicitly slid the window mid-history on
   * THAT agent.
   *
   * The agent-tag is load-bearing: switching agents must reset the
   * view to the latest, per the chat-UX spec. With the tag, a stale
   * `{agent: "friday", end: 50}` from a previous focus session has
   * no effect when the focused agent is now "linear-import" — the
   * agent-mismatch falls through to the "follow live tail" default
   * automatically, no init effect needed.
   *
   * Slide operations write `{ agent: focusedAgent, end: newEnd }`.
   * When a slide brings `end` to `allMessages.length` (back at the
   * tail), the writer sets this back to `null` so the next live-
   * append advances naturally without another mutator hop.
   */
  chatWindowEnd = $state<{ agent: string; end: number } | null>(null);

  /**
   * Reset the sliding window to the tail of all messages. Called by
   * the "↓ Latest" button in ChatShell — sets the cursor back to
   * `null` (follow live tail) so subsequent new messages auto-extend.
   * The caller follows up with `scrollTop = scrollHeight`.
   */
  resetChatWindowToLatest(): void {
    this.chatWindowEnd = null;
  }

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
  /** Per-agent failure flag for the sessions fetch (FRI-162). Set when the
   *  fetch ultimately fails after its bounded retries (non-ok response or a
   *  thrown fetch) so the history submenu can render a distinct error +
   *  Retry affordance instead of the misleading "No past sessions" — which
   *  is indistinguishable from a genuinely-empty agent. Cleared back to
   *  `false` at the start of each load attempt and on success. */
  sidebarSessionsError = $state<Record<string, boolean>>({});

  /** localStorage key for F3-C cursor persistence. Cleared when the
   *  daemon's boot_id changes (different process — old seqs are stale). */
  private static readonly LAST_SEQ_KEY = "chat:lastSeqByAgent";

  /**
   * Phase 3.7: Zero integration hook. `zero.svelte.ts` registers a
   * binder via {@linkcode setBlocksBinder} during module init; chat
   * calls it on focus change to bind / unbind the per-agent blocks
   * reactive query. Kept as a function reference (not a direct import)
   * to avoid the chat → zero → chat circular dependency. `null` when
   * Zero is disabled, or before the zero module finishes initializing.
   */
  private blocksBinder: ((agent: string | null) => void) | null = null;

  /**
   * `true` when the Phase 3.7 Zero binding is active for the current
   * focused agent. Set to true by {@linkcode applyZeroBlocks} when
   * rows arrive for a matching agent; reset on focus switch. The
   * chat scroller uses this to decide whether to suppress the
   * REST-driven `loadingInitial` skeleton (the Zero binding has its
   * own snapshot path that hits immediately when the WS is healthy).
   */
  zeroBlocksActive = $state(false);

  /** Register the Zero blocks binder. Idempotent on the same fn. */
  setBlocksBinder(fn: (agent: string | null) => void): void {
    this.blocksBinder = fn;
  }

  /**
   * Phase 4.1: callback that fires the `markRead` mutator with the
   * newest block id for the focused agent. Registered by
   * `zero.svelte.ts` at module init alongside the binder, kept as a
   * function reference for the same chat → zero circular-dep reasons.
   * `null` when Zero is off.
   */
  private markReadFn: ((agent: string, blockId: string) => void) | null = null;
  setMarkReadFn(fn: (agent: string, blockId: string) => void): void {
    this.markReadFn = fn;
  }
  /** Wired from `zero.svelte.ts` to avoid a circular import.
   *  Calls `zeroSync.sendUserMessage` with a pre-minted blockId.
   *  FRI-139: returns a discriminated outcome instead of `result|null`
   *  so callers can distinguish app-error (mark failed now) from
   *  transport-error (keep optimistic; arm fallback timer). */
  private sendMessageFn:
    | ((args: {
        blockId: string;
        agent: string;
        text: string;
        attachments?: Array<{ sha256: string; filename: string; mime: string }>;
      }) => Promise<SendUserMessageOutcome>)
    | null = null;
  setSendMessageFn(
    fn: (args: {
      blockId: string;
      agent: string;
      text: string;
      attachments?: Array<{ sha256: string; filename: string; mime: string }>;
    }) => Promise<SendUserMessageOutcome>,
  ): void {
    this.sendMessageFn = fn;
  }
  /** FRI-123: wired from `zero.svelte.ts` to avoid a circular import.
   *  Calls `zeroSync.resumeTurn(turnId)` which dispatches the
   *  resumeTurn mutator (replaces the retired
   *  `POST /api/chat/turn/<id>/resume` REST path). */
  private resumeTurnFn: ((turnId: string) => Promise<boolean>) | null = null;
  setResumeTurnFn(fn: (turnId: string) => Promise<boolean>): void {
    this.resumeTurnFn = fn;
  }
  /** FRI-139 review-2: wired from `zero.svelte.ts`. Called from
   *  `discardPending` / `discardAllPending` for each discarded queueId
   *  so the underlying mutation is cancelled at the daemon (and via
   *  the cancelQueued mutator for cross-device durability) instead of
   *  silently persisting after the optimistic UI bubble is dropped.
   *  Fire-and-forget — the caller doesn't await. */
  private discardCancelFn: ((blockId: string) => void) | null = null;
  setDiscardCancelFn(fn: (blockId: string) => void): void {
    this.discardCancelFn = fn;
  }
  /**
   * Per-agent memo of the latest block_id we've already passed to
   * `markRead`. Suppresses the redundant write that would otherwise
   * fire on every Zero snapshot frame (the cursor is already there).
   * Reset on focus switch so a re-focus re-establishes the cursor.
   */
  private lastMarkedBlockIdByAgent = new Map<string, string>();

  /**
   * Track every `block_id` that has appeared in a Zero snapshot for the
   * currently-focused agent. Used by {@linkcode applyZeroBlocks} to
   * distinguish "row was deleted upstream" (drop) from "bubble pre-dates
   * the Zero window" (preserve as scroll-back). Reset on focus switch
   * so a different agent's history doesn't trip the delete heuristic.
   * Bounded by the count of distinct blocks ever surfaced for the
   * focused agent in this page session — single-digit MB at worst.
   */
  private zeroSeenBlockIds = new Set<string>();

  constructor() {
    // F3-C (PR C): hydrate the per-agent SSE dedup cursor from
    // localStorage. Without this, every page reload reset the cursor to
    // empty and the daemon's ring-buffer replay re-counted old
    // `agent_message` events, producing phantom unread badges. The cursor
    // is invalidated separately when the connection_established event
    // carries a new boot_id (see acceptConnectionEstablished).
    const persisted = loadJSON<Record<string, number>>(ChatState.LAST_SEQ_KEY, {});
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
  upsertAgent(name: string, patch: Partial<Omit<AgentInfo, "name">>): void {
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

  /**
   * Wipe the live chat view for `agent`. Used by `/clear`: the daemon
   * has archived the worker and nulled the agent's `session_id`, so the
   * dashboard's painted transcript no longer reflects the agent's
   * actual context. The empty chat is the user-facing confirmation —
   * we deliberately do not push a synthetic "I cleared" assistant
   * bubble, because `sys_<ts>` synthetics aren't backed by `blocks`
   * rows and disappear on refresh / agent switch / session switch
   * (violates the chat-content-is-durable contract).
   *
   * No-op when `agent` isn't the focused one: `chat.messages` only
   * holds the focused agent's transcript, so there is nothing to wipe
   * for a background agent. The Zero `agents` snapshot already
   * propagated the `session_id = null` flip across devices; the next
   * time the user focuses that agent, `applyZeroBlocks` filters the
   * snapshot to its current session (empty, until the next turn) and
   * paints an empty chat naturally.
   */
  clearLocalView(agent: string): void {
    if (this.focusedAgent !== agent) return;
    this.#legacyMessages = [];
    // Wipe the focused agent's overlay entries too. The session-id stamp
    // on each entry would also hide them (clearLocalView is paired with
    // the agent's sessionId flipping to null at the daemon), but the
    // imperative drop keeps the maps from accumulating dead state across
    // repeated `/clear`s — the SvelteMap doesn't garbage-collect
    // mismatched-session entries on its own.
    for (const [key, entry] of this.streaming.entries()) {
      if (entry.agent === agent) this.streaming.delete(key);
    }
    for (const [key, entry] of this.optimistic.entries()) {
      if (entry.agent === agent) {
        // FRI-139: drop any armed transport-failure fallback along
        // with the bubble it would flip. `/clear` wipes the worker's
        // session; the bubble's `queueId` is moot from here.
        if (entry.queueId) this.clearTransportFailureTimer(entry.queueId);
        this.optimistic.delete(key);
      }
    }
    this.oldestBlockId = null;
    this.reachedOldest = false;
    this.historyError = null;
    this.zeroBlocksActive = false;
    this.zeroSeenBlockIds = new Set();
    this.loadingOlder = false;
    // Suppress the skeleton-shimmer post-clear. Without this the empty
    // chat that should signal "session cleared, type to start fresh"
    // is masked by the loading affordance until the next Zero snapshot
    // lands — confusing because the agent is intentionally at rest.
    this.loadingInitial = false;
    // The daemon SIGTERMs the worker as part of `/clear`; any value in
    // the per-agent inflight slot points at a turn id that no longer
    // exists, which would mis-render the input bar's Send affordance
    // as Stop on the next render frame.
    this.inflightTurnIdByAgent[agent] = null;
    // Wipe the localStorage transcript cache for this agent. The cache
    // is the first-paint source on reload (loadAgentTurns reads it
    // before Zero pushes a snapshot), so leaving it in place lets the
    // pre-clear session's blocks bleed back onto the screen the moment
    // the user refreshes the tab. The cache only ever gets re-written
    // by the legacy REST path (`saveJSON(KEYS.transcript(...))` in
    // `loadAgentTurns`), which is dormant when Zero is the data path —
    // historical caches from the pre-Zero era stay around indefinitely
    // until something explicitly invalidates them. `/clear` is that
    // moment for this agent.
    removeKey(KEYS.transcript(agent));
  }

  /** Apply an agent_status event with a debounce on working→idle so brief
   * inter-turn idle pulses don't flicker the dot. Working transitions and
   * non-binary states (stalled/archived) apply immediately.
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

  /** Snapshot of the focused agent's current SDK session id. Stamped onto
   *  StreamingEntry / OptimisticEntry constructions so the `messages`
   *  derivation can filter overlay entries by session — /clear nulls the
   *  agent's sessionId and stale in-flight entries become invisible
   *  without imperative cleanup. */
  private currentSessionFor(agent: string): string | null {
    return this.agents.find((a) => a.name === agent)?.sessionId ?? null;
  }

  addUser(
    text: string,
    opts?: {
      queueId?: string;
      attachments?: Array<{ sha256: string; filename: string; mime: string }>;
      /**
       * FRI-72: the authoritative agent this send targets. ChatInput passes
       * the URL-resolved `sendAgent` so the optimistic overlay entry is
       * keyed/stamped by the SAME agent as the canonical Zero write —
       * otherwise, when `focusedAgent` lags a navigation, the bubble is
       * stored under the wrong agent and the `#derivedMessages` overlay
       * filter (`entry.agent !== focused`) drops it from the visible surface.
       * Falls back to `focusedAgent` for callers without a route context.
       */
      agent?: string;
    },
  ): string {
    // FIX_FORWARD 2.6: mint a `pending_<uuid>` id and `pending: true` so
    // the bubble pins to the bottom of the chat until the dispatch lands.
    // `confirmPending` drops this overlay entry and pushes a canonical
    // bubble at `userBlockIdForTurn(turnId)` once Zero's mutator
    // resolves; the daemon's `recordUserBlock` writes the same id and
    // Zero replicates it next, which dedups in applyZeroBlocks's merge.
    const id = `pending_${randomUUID()}`;
    const agent = opts?.agent ?? this.focusedAgent;
    this.optimistic.set(
      overlayKey(agent, id),
      new OptimisticEntry({
        id,
        agent,
        ts: Date.now(),
        // No real turnId yet — the pending id stands in until confirmPending
        // lands the daemon-issued one.
        turnId: id,
        sessionId: this.currentSessionFor(agent),
        text,
        source: "user_chat",
        queueId: opts?.queueId,
        attachments: opts?.attachments,
        initialStatus: "complete",
        initialPending: true,
      }),
    );
    return id;
  }

  /**
   * The pending user bubble (matched by `queueId`) has been confirmed by
   * Zero's mutator returning `{turn_id}`. Drop the optimistic overlay
   * entry and push a confirmed canonical bubble into the legacy bucket
   * at `userBlockIdForTurn(turnId)` — the same id the daemon's
   * `recordUserBlock` will emit and the same id Zero will replicate.
   * applyZeroBlocks's merge dedups by id, so the canonical row that
   * lands later replaces the legacy entry without surfacing a duplicate.
   */
  confirmPending(queueId: string, turnId: string, agent?: string): void {
    this.clearTransportFailureTimer(queueId);
    const targetId = userBlockIdForTurn(turnId);
    // FRI-72: confirm by the SAME authoritative agent the bubble was stored
    // under (`addUser`'s `sendAgent`), not the possibly-lagging
    // `focusedAgent`. If the route caught up after the optimistic write, the
    // entry lives under the send agent; matching on `focusedAgent` would miss
    // it and early-return without ever confirming the bubble.
    const targetAgent = agent ?? this.focusedAgent;
    let entry: OptimisticEntry | undefined;
    let entryKey: OverlayKey | undefined;
    for (const [k, e] of this.optimistic.entries()) {
      if (e.queueId === queueId && e.agent === targetAgent) {
        entry = e;
        entryKey = k;
        break;
      }
    }
    if (!entry || !entryKey) return;
    // Defense in depth against an SSE-first race: if the daemon's
    // `block_complete` SSE frame arrived *before* this confirmPending
    // call, `handleBlockComplete` already pushed a canonical bubble at
    // `userBlockIdForTurn(turnId)`. Pushing another one would surface
    // two bubbles sharing the same id and crash the keyed `{#each}`.
    // Drop the optimistic in that case — the SSE bubble is canonical.
    const sseAlreadyHere = userBubbleAlreadyLanded(
      this.#legacyMessages,
      [...this.streaming.values()],
      targetId,
    );
    this.optimistic.delete(entryKey);
    if (sseAlreadyHere) return;
    this.#legacyMessages.push({
      id: targetId,
      role: "user",
      text: entry.text,
      status: "complete",
      ts: entry.ts,
      agent: targetAgent,
      turnId,
      source: entry.source,
      attachments: entry.attachments,
      pending: false,
      failed: false,
      queueId: undefined,
    });
  }

  /** Mark the pending bubble for this queueId as failed so the UI
   *  surfaces a discard affordance.
   *
   *  FRI-139: fire on app-error (server rejected the write) and on
   *  no-zero (Zero never initialised) — the cases where the DB row
   *  definitively does not exist. Transport-class signals (zero-error)
   *  go through {@link scheduleTransportFailureFallback} instead, so a
   *  WS hiccup mid-send doesn't flash FAILED-TO-SEND on every restart-
   *  window message even when the server-side push committed.
   *
   *  FRI-139 review-1: also releases the eager inflight slot for this
   *  send. ChatInput's submit path stamps `inflightTurnIdByAgent[agent]
   *  = \`t_${blockId}\`` synchronously when the user hits send; the
   *  transport-failure fallback timer ends up here when the bubble
   *  flips to FAILED. Without this release, the input bar would show
   *  the Stop affordance (busy state survives off the eager claim)
   *  while the bubble says "Failed to send" — affordances disagreeing
   *  is the worst kind of UI bug. The eager pattern is fixed
   *  (`t_<queueId>`), so we can release without storing the eagerTurnId
   *  separately. */
  markPendingFailed(queueId: string): void {
    this.clearTransportFailureTimer(queueId);
    transportFailureLog("mark-failed", queueId);
    for (const entry of this.optimistic.values()) {
      if (entry.queueId !== queueId) continue;
      entry.failed = true;
      const eagerTurnId = `t_${queueId}`;
      if (this.inflightTurnIdByAgent[entry.agent] === eagerTurnId) {
        this.markInflight(entry.agent, null);
      }
      return;
    }
  }

  /**
   * FRI-139: open transport-failure fallback timers, keyed by queueId.
   *
   * When `zeroSync.sendUserMessage` resolves to `transport-error`, the
   * caller arms one of these instead of marking failed. If the canonical
   * row arrives via `applyZeroBlocks` (or the user discards / the
   * mutator's eventual ack comes through via `confirmPending`) before
   * the timer fires, we clear it and the bubble heals invisibly. If
   * 30s pass with no canonical row, the timer flips `failed:true` as a
   * last-resort affordance so the user isn't stuck with an
   * indefinitely-spinning "Sending…".
   *
   * Keying by queueId (= pre-minted blockId) matches the lifetime of
   * the optimistic entry, so cleanup paths can look it up without
   * holding a separate reference to the entry.
   */
  private pendingFailureTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * FRI-139: default 30s window covers cellular reconnect + zero-cache
   * push retry + WS ack round-trip on a degraded link. SSE keepalive
   * declares-dead at 40s; this fires earlier so the affordance shows
   * before the user reaches for refresh.
   *
   * FRI-139 review-5: caveat for iOS PWA. When the tab is backgrounded,
   * Safari throttles `setTimeout` to ~1Hz, so a 30s deadline can fire
   * meaningfully late on resume. Mitigation in practice: when the tab
   * wakes, `applyZeroBlocks` typically delivers the canonical row
   * before the throttled timer drains, which cancels via
   * {@link clearTransportFailureTimer}. The visibility-driven Zero
   * reconnect (`zero.svelte.ts` `visibilitychange` handler) fires
   * sooner than the timer either way. Worst case the user sees a
   * delayed FAILED-TO-SEND chrome on tab resume — acceptable trade.
   *
   * FRI-139 review-6: structured logging at arm / fire / cancel goes
   * through {@link transportFailureLog} so production telemetry can
   * tune this threshold from real fire-vs-cancel cadence rather than
   * the desk-side guess.
   */
  static readonly TRANSPORT_FAILURE_FALLBACK_MS = 30_000;

  /**
   * FRI-139: arm the long-window fallback for a transport-error send.
   * Idempotent — re-arming for the same queueId clears the prior timer.
   * If the bubble already vanished (canonical row replaced it before
   * the wrapper resolved), nothing is scheduled.
   */
  scheduleTransportFailureFallback(
    queueId: string,
    delayMs: number = ChatState.TRANSPORT_FAILURE_FALLBACK_MS,
  ): void {
    this.clearTransportFailureTimer(queueId);
    let entryStillExists = false;
    for (const entry of this.optimistic.values()) {
      if (entry.queueId === queueId) {
        entryStillExists = true;
        break;
      }
    }
    if (!entryStillExists) return;
    transportFailureLog("arm", queueId, { delayMs });
    const t = setTimeout(() => {
      this.pendingFailureTimers.delete(queueId);
      // Only flip if the optimistic still exists at fire time —
      // canonical row delivery via `applyZeroBlocks` would have already
      // dropped it, and we'd be lighting up failed state for a bubble
      // that no longer renders. Route through `markPendingFailed` so
      // the inflight slot release (FRI-139 review-1) is consistent
      // across timer-fire and direct-call paths.
      for (const entry of this.optimistic.values()) {
        if (entry.queueId === queueId) {
          transportFailureLog("fire", queueId);
          this.markPendingFailed(queueId);
          return;
        }
      }
      transportFailureLog("fire-stale", queueId);
    }, delayMs);
    this.pendingFailureTimers.set(queueId, t);
  }

  /** FRI-139: cancel a queued transport-failure fallback. Called when
   *  the canonical row lands (confirmPending / applyZeroBlocks drop),
   *  when the user discards manually, or before re-arming. */
  clearTransportFailureTimer(queueId: string): void {
    const t = this.pendingFailureTimers.get(queueId);
    if (t !== undefined) {
      clearTimeout(t);
      this.pendingFailureTimers.delete(queueId);
      transportFailureLog("cancel", queueId);
    }
  }

  /** Remove the pending bubble matching `queueId` (FIX_FORWARD 2.7 — used
   *  when the user picks "Discard and continue" or "Discard all").
   *
   *  FRI-139 review-2: also fires the wired `discardCancelFn` so the
   *  underlying mutation is cancelled at the daemon if it actually
   *  committed (the transport-error case where the WS ack got lost but
   *  the push landed). Without this, DISCARD silently created duplicate
   *  turns on retry. */
  discardPending(queueId: string): void {
    this.clearTransportFailureTimer(queueId);
    let dropped = false;
    for (const [key, entry] of this.optimistic.entries()) {
      if (entry.queueId === queueId) {
        this.optimistic.delete(key);
        dropped = true;
      }
    }
    if (dropped) this.discardCancelFn?.(queueId);
  }

  /** Remove every pending bubble in one go (FIX_FORWARD 2.7 — "Discard all
   *  and continue").
   *
   *  FRI-139 review-2: fans the cancel-mutation hook across every
   *  discarded entry. */
  discardAllPending(): void {
    const cancels: string[] = [];
    for (const [key, entry] of this.optimistic.entries()) {
      if (entry.pending) {
        if (entry.queueId) {
          this.clearTransportFailureTimer(entry.queueId);
          cancels.push(entry.queueId);
        }
        this.optimistic.delete(key);
      }
    }
    if (this.discardCancelFn) {
      for (const blockId of cancels) this.discardCancelFn(blockId);
    }
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
  /**
   * Land a /jump on an already-local chat message. Slides the rendered
   * window to include the target (sliding-window virtualization caps
   * the DOM at ~WINDOW_SIZE messages; without this, jumps below the
   * current window mount nothing into the DOM and scrollIntoView
   * silently fails). Sets `scrollTarget` so the ChatMessages effect
   * runs scrollIntoView after the next paint.
   */
  #scrollLocalJump(target: ChatMessage): void {
    const idx = this.messages.indexOf(target);
    if (idx !== -1) {
      // Park the target ~20 from the bottom of the rendered window;
      // ChatMessages's WINDOW_SIZE (100) then covers ~80 messages
      // above it, giving the user immediate context in both directions
      // without mounting the entire transcript. The "+20" must stay
      // strictly < WINDOW_SIZE so the target itself lands inside the
      // window (otherwise windowStart = end - WINDOW_SIZE > idx).
      const end = Math.min(this.messages.length, idx + 20);
      this.chatWindowEnd = { agent: this.focusedAgent, end };
    }
    this.pinnedToBottom = false;
    this.scrollNonce += 1;
    this.scrollTarget = { id: target.id, nonce: this.scrollNonce };
  }

  async jumpTo(agent: string, arg: string): Promise<void> {
    const trimmed = arg.trim();
    if (!trimmed) {
      this.setToast("Usage: /jump <date|term>", "warn");
      return;
    }
    const ts = parseJumpDate(trimmed);
    const isDateJump = ts !== null;

    // Local-first path (plan §39 phase 3 "lazy on demand"): if the
    // target is within the client retention horizon, every matching
    // block is already in `this.messages` — there's no REST round-trip
    // needed. Try to land the jump from the local Zero replica first;
    // fall through to the REST endpoint only when local doesn't have
    // a candidate (e.g., the date is older than the 90d retention or
    // the FTS match needs Postgres tsvector ranking).
    const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
    const targetTsWithinRetention = isDateJump ? (ts as number) > Date.now() - RETENTION_MS : false;
    if (isDateJump && targetTsWithinRetention) {
      // Earliest block on or after the target ts that the user would
      // recognize as "the start of that day's chat" — same selection
      // rule the REST-driven branch uses.
      const targetTs = ts as number;
      let candidate: ChatMessage | undefined;
      for (const m of this.messages) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        // Skip error / no-response affordance bubbles — they carry no
        // user-recognizable body text to land a jump on. (Regular
        // assistant text + user_chat messages have `kind === undefined`.)
        if (m.kind !== undefined) continue;
        if (m.ts < targetTs) continue;
        if (!candidate || m.ts < candidate.ts) candidate = m;
      }
      if (candidate) {
        this.#scrollLocalJump(candidate);
        return;
      }
      // Target ts is within retention but no local candidate at-or-after.
      // Could be a date past the end of chat — let the REST path warn.
    } else if (!isDateJump) {
      // Term mode: try a case-insensitive substring scan on the local
      // replica first. Pure-JS scan over the ~thousand-message Zero
      // snapshot is sub-millisecond and avoids the daemon round-trip
      // for the common case where the user is searching recent chat.
      // Newest match wins (FTS would rank; the local fallback prefers
      // recency since that's what a humans reasoning about "did I just
      // say X" expects).
      const needle = trimmed.toLowerCase();
      let recentMatch: ChatMessage | undefined;
      for (const m of this.messages) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        if (typeof m.text !== "string" || m.text.length === 0) continue;
        if (!m.text.toLowerCase().includes(needle)) continue;
        if (!recentMatch || m.ts > recentMatch.ts) recentMatch = m;
      }
      if (recentMatch) {
        this.#scrollLocalJump(recentMatch);
        return;
      }
      // No local hit — fall through to the REST FTS endpoint.
    }

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
      this.setToast(err instanceof Error ? err.message : "Jump failed.", "warn");
      return;
    }

    if (rawBlocks.length === 0) {
      this.setToast(isDateJump ? "No chat on that date." : "No matches.", "warn");
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

    const parsed = parseBlocks(rawBlocks, agent, {
      inflightTurnId: this.inflightTurnIdByAgent[agent] ?? null,
      noResponseGraceUntil: this.noResponseGraceUntil,
      now: Date.now(),
    });

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
        (b) => (b.role === "user" || b.role === "assistant") && b.kind === "text",
      );
      if (top) {
        targetId = top.role === "user" ? userBlockIdForTurn(top.turnId) : `b_${top.blockId}`;
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
    this.#legacyMessages = [...settled, ...pending];

    if (targetId) {
      this.scrollNonce += 1;
      this.scrollTarget = { id: targetId, nonce: this.scrollNonce };
      if (!isDateJump) {
        this.highlightedMessageId = targetId;
        const matchCount = rawBlocks.filter(
          (b) => (b.role === "user" || b.role === "assistant") && b.kind === "text",
        ).length;
        this.setToast(`${matchCount} match${matchCount === 1 ? "" : "es"}`, "info");
      }
    } else if (!isDateJump) {
      // Term mode returned only tool/thinking rows — nothing the user
      // can meaningfully be shown.
      this.setToast("No matches.", "warn");
    }
  }

  startAssistantTurn(turnId: string, agent: string): void {
    this.markInflight(agent, turnId);
    this.#legacyMessages.push({
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
    this.#legacyMessages.push({
      id,
      role: "assistant",
      text: delta,
      status: "streaming",
      agent: this.focusedAgent,
      turnId,
      ts: Date.now(),
    });
  }

  finishTurn(
    turnId: string,
    status: "complete" | "aborted" | "error",
    abortReason?: "cooperative" | "forced",
  ): void {
    // Safety net for the iterator-error path. The worker now flushes
    // in-flight blocks with a terminal status on catch, but if any tool /
    // thinking bubble slips through (eviction, dropped block-stop, JSONL
    // recovery race), close it here using the turn-level status — never
    // leave a `running` bubble pinned to a turn the daemon has declared
    // done. Assistant text bubbles use the same matching rule they always
    // have.
    const userBlockId = userBlockIdForTurn(turnId);
    // Helper applied to each message regardless of which bucket it
    // lives in (legacy or streaming overlay). In-place status / field
    // mutations are reactive in both: $state items on the legacy
    // $state array, and per-instance $state fields on StreamingEntry.
    const flip = (m: ChatMessage): void => {
      // FRI-95: the user block participates in turn-level terminal-state
      // resolution. It's the always-present render surface for the Stop
      // affordance (Stopping… → Stopped / Stopped — worker had to be
      // force-killed / Already finished), independent of whether an
      // assistant bubble streamed.
      if (m.id === userBlockId) {
        if (status === "aborted") {
          m.status = "aborted";
          if (abortReason) m.abortReason = abortReason;
        } else if (status === "complete" && m.status === "stopping") {
          // Race: user clicked Stop but the turn raced to a clean
          // completion before the daemon could honor the abort. Render
          // a brief `already_finished` transient so the user knows the
          // click registered, then settle back to `complete`.
          m.status = "already_finished";
          const settleAfterMs = 1000;
          setTimeout(() => {
            // Re-find the message — the user may have navigated away or
            // the row may have been swapped by reconcile. Only flip if
            // it's still in the transient state we set.
            for (const m2 of this.messages) {
              if (m2.id === userBlockId && m2.status === "already_finished") {
                m2.status = "complete";
                break;
              }
            }
          }, settleAfterMs);
        }
        return;
      }
      if (m.id !== turnId && m.turnId !== turnId) return;
      if (m.role === "assistant") {
        if (m.status === "complete" || m.status === "aborted" || m.status === "error") {
          return;
        }
        m.status = status;
        if (status === "aborted" && abortReason) m.abortReason = abortReason;
      } else if (m.role === "tool" || m.role === "thinking") {
        if (m.status === "done" || m.status === "error" || m.status === "aborted") {
          return;
        }
        m.status = status === "complete" ? "done" : status;
      }
    };
    // Streaming overlay first (this is where SSE-driven in-flight
    // bubbles live since commit 5). Scoped to the focused agent so a
    // turn_done for a non-focused agent doesn't touch its overlay.
    for (const entry of this.streaming.values()) {
      if (entry.agent !== this.focusedAgent) continue;
      flip(entry);
    }
    // Legacy bucket carries the user block and any reload-mid-stream
    // canonical entries; iterate after the overlay so id collisions
    // (overlay shadows legacy by id) still get both copies flipped.
    for (const m of this.#legacyMessages) flip(m);
    // Inflight-slot cleanup is delegated to `clearInflightForTurn` so
    // applyEvent's `turn_done` / `error` cases can clear the slot for
    // non-focused agents without going through the message-walking
    // path here (which only ever touches focused-agent messages).
    this.clearInflightForTurn(turnId);
    // FRI-60: schedule cleanup of the zero-block reason. Uses a short
    // timeout (rather than immediate delete) so the reactive applyZeroBlocks
    // path has time to read the reason and attach it to the synthesized
    // no-response bubble before it's removed.
    if (this.zeroBlockReasonByTurn[turnId] !== undefined) {
      const REASON_CLEANUP_MS = 5_000;
      setTimeout(() => {
        delete this.zeroBlockReasonByTurn[turnId];
      }, REASON_CLEANUP_MS);
    }
  }

  /**
   * Per-turn grace deadline (epoch ms) after `clearInflightForTurn`.
   * SSE `turn_done` arrives on a separate transport from Zero's WS
   * push of the assistant blocks — there's a brief window where
   * the slot is cleared but the assistant content hasn't replicated
   * to this client yet. parseBlocks's FRI-85 safety net consults
   * this to avoid synthesizing a spurious "Agent didn't respond"
   * bubble in that gap.
   */
  noResponseGraceUntil = $state<Record<string, number>>({});
  /** Epoch ms; no-response guard is suppressed while now < this. Set on reconnect. */
  reconnectGraceUntil = $state<number>(0);

  /**
   * FRI-60: maps turn_id → zero_block_reason for turns that ended with no
   * content blocks. Populated by `applyEvent` when `turn_done` carries
   * `zero_block_reason`; read by `parseBlocks` to set the right copy on the
   * synthesized no-response bubble; cleaned up in `finishTurn` via a short
   * setTimeout so the reactive `applyZeroBlocks` path has time to read it.
   */
  zeroBlockReasonByTurn = $state<Record<string, "abort" | "compaction" | "sdk-resume-failure">>({});

  /**
   * FRI-156 §E: id of the most-recent durable compaction divider message
   * (`cb_<blockId>`) currently in the focused agent's view, or null when
   * there is none. Drives the "Viewing pre-compaction history" pill: the
   * pill shows when the user is scrolled ABOVE this divider. ChatMessages
   * observes the divider element and flips {@link viewingPreCompaction}.
   */
  latestCompactionDividerId = $derived.by<string | null>(() => {
    let id: string | null = null;
    for (const m of this.messages) {
      if (m.kind === "compaction") id = m.id;
    }
    return id;
  });

  /**
   * FRI-156 §E: true when the user is scrolled above the most-recent
   * compaction divider — i.e. they're looking at pre-compaction history.
   * Set by ChatMessages's IntersectionObserver on the divider element;
   * read by ChatShell to show the sticky "Viewing pre-compaction history"
   * pill. Reset to false whenever there is no divider in view.
   */
  viewingPreCompaction = $state(false);

  /**
   * FRI-156 §F: set of agent names whose context is currently being
   * compacted. An agent is added on the `compacting` SSE event's
   * `phase:'start'` frame and removed on `phase:'done'`. A SET (not a single
   * scalar) so the nightly sweep compacting two agents at once can't clobber
   * one another's spinner, and a dropped `done` for one agent never masks
   * another. Defensively cleared on the agent's terminal turn events
   * (turn_done / error) so a worker that dies mid-compaction — emitting no
   * `done` frame — can't wedge the "Compacting context…" indicator on. The
   * focused-agent gate lives in {@link focusedAgentIsCompacting} so a
   * background agent's compaction doesn't surface a spinner in the user's
   * current chat. Reactive via SvelteSet so membership changes re-render.
   */
  compactingAgents = new SvelteSet<string>();

  /**
   * True when `name`'s context is compacting, per EITHER signal:
   *   - the transient SSE set ({@link compactingAgents}) — low-latency, lights
   *     the instant the `compacting` start frame arrives; and
   *   - the durable `agents.compacting_since` column (replicated via Zero) —
   *     reconstructs after a reload/reconnect or across the daemon-restart
   *     window, where the SSE set (in-memory) is empty.
   * Unioning the two means the indicator lights instantly AND survives reload.
   * Reactive: reads `compactingAgents` membership and the agent row's
   * `compactingSince`, so both a set mutation and a Zero row update re-render.
   */
  isAgentCompacting(name: string): boolean {
    if (this.compactingAgents.has(name)) return true;
    const row = this.agents.find((a) => a.name === name);
    return row?.compactingSince != null;
  }

  /** The compaction start instant (epoch-millis) for `name`, from the durable
   *  column — used for the elapsed-time readout. Undefined when not compacting
   *  or when only the transient SSE signal is present (column not yet
   *  replicated): callers render the label without a timer until it lands. */
  compactingSinceFor(name: string): number | undefined {
    return this.agents.find((a) => a.name === name)?.compactingSince;
  }

  /** FRI-156 §F: true while the FOCUSED agent's context is compacting.
   *  Drives the transient "Compacting context…" indicator in ChatMessages.
   *  Now reconstructable — see {@link isAgentCompacting}. */
  get focusedAgentIsCompacting(): boolean {
    return this.isAgentCompacting(this.focusedAgent);
  }

  /** FRI-156 §E: scroll the chat to the most-recent compaction divider.
   *  Reuses the nonce-keyed `scrollTarget` mechanism (ChatMessages's
   *  effect runs `scrollIntoView` on the matching `data-msg-id`). No-op
   *  when there is no divider. Called from the pre-compaction pill.
   *
   *  Mirrors `#scrollLocalJump`: the divider may be older than the most
   *  recent WINDOW_SIZE messages and thus UNMOUNTED by virtualization. Slide
   *  `chatWindowEnd` to include it FIRST so the divider node exists when the
   *  scrollTarget effect runs `scrollIntoView` — otherwise the click is a
   *  silent no-op (the effect querySelectors the missing node and bails). */
  scrollToLatestCompactionDivider(): void {
    const id = this.latestCompactionDividerId;
    if (!id) return;
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx !== -1) {
      // Park the divider ~20 from the bottom of the rendered window (must stay
      // strictly < WINDOW_SIZE so the divider itself lands inside the slice).
      const end = Math.min(this.messages.length, idx + 20);
      this.chatWindowEnd = { agent: this.focusedAgent, end };
    }
    this.scrollNonce += 1;
    this.scrollTarget = { id, nonce: this.scrollNonce };
  }

  /**
   * Clear any per-agent inflight slot whose value matches `turnId`.
   * Preserves the requestStop race invariant — if a mail-driven T2
   * started on the same agent before T1's terminal event landed, the
   * slot was already overwritten to T2 and won't be clobbered here.
   *
   * Also records a short grace window for `noResponseGraceUntil` so
   * the FRI-85 safety net doesn't flash "Agent didn't respond" in
   * the SSE-faster-than-Zero race described on that field.
   */
  clearInflightForTurn(turnId: string): void {
    let cleared = false;
    for (const [agent, slotTurnId] of Object.entries(this.inflightTurnIdByAgent)) {
      if (slotTurnId === turnId) {
        this.inflightTurnIdByAgent[agent] = null;
        cleared = true;
      }
    }
    if (cleared) {
      // 2s is enough to absorb local Zero replication latency
      // (typically <500ms) plus the dashboard-side parse pass; longer
      // would risk hiding a genuinely-failed turn for too long.
      const NO_RESPONSE_GRACE_MS = 2_000;
      this.noResponseGraceUntil[turnId] = Date.now() + NO_RESPONSE_GRACE_MS;
      // Self-clean so the map doesn't grow without bound. The +250ms
      // slop keeps the deadline check above the cleanup delay so a
      // parseBlocks pass right at the boundary doesn't see a stale
      // entry that's already been deleted.
      setTimeout(() => {
        delete this.noResponseGraceUntil[turnId];
      }, NO_RESPONSE_GRACE_MS + 250);
    }
  }

  /**
   * Reconcile in-memory bubble status against Zero's agents-table truth.
   *
   * The Phase 5b retirement of the `agent_status` SSE event made
   * `agents.status` (replicated via Zero) the canonical signal for
   * "is this agent doing anything right now." When that column flips
   * to `'idle'` or `'stalled'`, every bubble for the focused agent
   * still showing `'running'` / `'streaming'` is a wedge — either
   * because a tool_result row was lost, the SSE per-turn replay
   * buffer was evicted before reconnect, or parseBlocks emitted a
   * `'running'` for a canonical tool_use row whose tool_result lands
   * in a later Zero frame and never flipped the bubble back.
   *
   * This reconciler is the safety net the Phase 5 retirement plan
   * implied but never wired. Fires from `zero.svelte.ts`'s
   * `#bindAgents` listener on every agents snapshot — idempotent on
   * "nothing to heal."
   *
   * Only acts on the focused agent (chat.messages only holds that
   * agent's transcript). Non-focused agents' wedges heal on the next
   * focus-switch since `applyZeroBlocks` re-parses from canonical rows
   * and this reconciler runs again immediately after.
   */
  reconcileAgentStatuses(rows: readonly { name: string; status: string }[]): void {
    const focused = this.focusedAgent;
    if (!focused) return;
    const focusedRow = rows.find((a) => a.name === focused);
    if (!focusedRow) return;
    // 'working' is the in-flight signal — don't heal. Any other
    // terminal-or-quiescent state ('idle', 'stalled',
    // 'archived', 'archive_requested') means the daemon isn't
    // actively producing output for this agent; bubbles claiming
    // otherwise are stale.
    if (focusedRow.status === "working") return;
    let healed = false;
    // Heal the streaming overlay first — that's where SSE-driven
    // in-flight bubbles live. Each entry's status is a $state field,
    // so the assignment fires fine-grained reactivity on any reader.
    for (const entry of this.streaming.values()) {
      if (entry.agent !== focused) continue;
      if (entry.role === "assistant" && entry.status === "streaming") {
        entry.status = "complete";
        healed = true;
      } else if (
        (entry.role === "tool" || entry.role === "thinking") &&
        entry.status === "running"
      ) {
        entry.status = "done";
        healed = true;
      }
    }
    // Legacy bucket still carries streaming/running entries in two
    // residual cases: a reload-mid-stream that landed a status='streaming'
    // canonical Zero row before SSE caught up (the row's deltas route
    // via the legacy fallback in handleBlockDelta), and any pre-overlay
    // imperative pushes a test fixture might have made.
    for (const m of this.#legacyMessages) {
      if (m.role === "assistant" && m.status === "streaming") {
        m.status = "complete";
        healed = true;
      } else if ((m.role === "tool" || m.role === "thinking") && m.status === "running") {
        m.status = "done";
        healed = true;
      }
    }
    if (this.inflightTurnIdByAgent[focused] != null) {
      this.inflightTurnIdByAgent[focused] = null;
      healed = true;
    }
    // Touch `messages` so $state's reactivity fires for any consumer
    // that does identity-based diff (the per-message mutations above
    // are picked up by Svelte's fine-grained reactivity, but explicit
    // is cheaper than relying on it for the listener side effect).
    if (healed) this.#legacyMessages = [...this.#legacyMessages];
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
    // Disable while any other turn is in flight on the focused agent.
    if (this.inflightTurnId !== null) return false;
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
    const blockId = randomUUID();
    const newTurnId = `t_${blockId}`;
    // FRI-72: the URL route is authoritative for the per-message Resend
    // affordance too. Resolve from the current pathname and let it win over
    // the possibly-lagging `focusedAgent`; fall back to `focusedAgent` when
    // there's no live chat route (or no DOM, e.g. unit tests).
    const routeAgent =
      typeof window !== "undefined" ? resolveSendTargetAgent(window.location.pathname) : null;
    const agent = routeAgent ?? this.focusedAgent;
    this.addUser(text, { queueId: blockId, agent });
    const claimedInflight = this.inflightTurnIdByAgent[agent] == null;
    if (claimedInflight) this.markInflight(agent, newTurnId);
    const sendPromise: Promise<SendUserMessageOutcome> =
      this.sendMessageFn?.({ blockId, agent, text }) ?? Promise.resolve({ kind: "no-zero" });
    void sendPromise.then((outcome) => {
      if (outcome.kind === "ok") {
        this.confirmPending(blockId, outcome.turnId, agent);
        this.markInflight(agent, outcome.turnId);
        return;
      }
      if (outcome.kind === "transport-error") {
        // FRI-139: keep the bubble pending; armed timer surfaces failure
        // only if the canonical row doesn't land in the 30s window.
        // Don't clear inflight — Zero's outbox retry is in flight, and
        // a stale inflight slot is preferable to a flash of "Send" UI
        // that immediately flips back to Stop when the row lands.
        this.scheduleTransportFailureFallback(blockId);
        return;
      }
      // app-error (server rejected — DB row absent) or no-zero (Zero
      // never initialised). Mark failed immediately.
      if (claimedInflight && this.inflightTurnIdByAgent[agent] === newTurnId) {
        this.markInflight(agent, null);
      }
      this.markPendingFailed(blockId);
    });
  }

  /**
   * FRI-123: re-dispatch the original prompt under the SAME turn_id
   * so the retry's blocks visually group with the error bubble.
   * Dispatches the `resumeTurn` Zero mutator (via the wired
   * `resumeTurnFn` from `zero.svelte.ts`); the daemon's
   * resume-listener reads the user block, rebuilds the prompt, and
   * re-dispatches under the same turnId.
   *
   * Replaces the retired
   * `POST /api/chat/turn/<id>/resume` REST path (ADR-024 retirement set).
   */
  async resumeTurn(turnId: string): Promise<void> {
    if (!this.resumeTurnFn) {
      this.setToast("Resume failed (Zero not ready).", "warn");
      return;
    }
    const ok = await this.resumeTurnFn(turnId);
    if (!ok) {
      this.setToast("Resume failed.", "warn");
    }
    // Success path: the daemon's `turn_started` SSE will arrive next
    // and populate inflightTurnId. Nothing else to do here.
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
    let assistantMarked = false;
    let assistantTerminal = false;
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      if (m.id !== turnId && m.turnId !== turnId) continue;
      if (m.status === "complete" || m.status === "aborted" || m.status === "error") {
        assistantTerminal = true;
        break;
      }
      // Already stopping: caller can still fire the POST again but the
      // UI is already in the right place. Return true so the caller's
      // "I requested stop" branch keeps running.
      if (m.status === "stopping") {
        assistantMarked = true;
        break;
      }
      m.status = "stopping";
      assistantMarked = true;
      break;
    }
    // If the assistant bubble exists and is in a terminal state, the turn
    // is fully done. Don't smear "stopping" onto the user block — that
    // would falsely claim Stop is meaningful on a finished turn.
    if (assistantTerminal) return false;
    // FRI-95: fall through to the user-block message. When Stop fires
    // before the first assistant block-start (queued turn, early stop, or
    // worker still in initial-thinking phase), there's no assistant bubble
    // to flip — but the user block is always present from the moment the
    // user pressed Send. Marking it `stopping` gives the dashboard a
    // stable surface for the optimistic "Stopping…" affordance.
    //
    // The user block's NORMAL baseline is `status="complete"` (the user's
    // message is itself a completed block — it's the turn that's still
    // in flight, not the user message). So `complete` is NOT a reason to
    // refuse Stop here. Only the turn-terminal post-abort states are.
    const userBlockId = userBlockIdForTurn(turnId);
    for (const m of this.messages) {
      if (m.id !== userBlockId) continue;
      if (m.status === "aborted" || m.status === "error" || m.status === "already_finished") {
        // User block already settled in a turn-terminal state. Defer to
        // the assistant-side decision.
        return assistantMarked;
      }
      if (m.status === "stopping") return true; // already optimistic
      m.status = "stopping";
      return true;
    }
    // No user block in messages (e.g., reload-mid-flight before the
    // block_complete arrives). The assistant marking is the load-bearing
    // affordance; return its result.
    return assistantMarked;
  }

  pushTool(toolId: string, toolName: string, input: unknown): void {
    const id = `t_${toolId}`;
    if (this.messages.some((m) => m.id === id)) return;
    this.#legacyMessages.push({
      id,
      role: "tool",
      text: "",
      status: "running",
      agent: this.focusedAgent,
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
    this.#legacyMessages.push({
      id,
      role: "tool",
      text: "",
      status: "running",
      agent: this.focusedAgent,
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
    this.#legacyMessages.push({
      id,
      role: "tool",
      text: "",
      status: status === "ok" ? "done" : "error",
      agent: this.focusedAgent,
      toolId,
      output,
      ts: Date.now(),
    });
  }

  pushThinking(blockId: string): void {
    const id = `th_${blockId}`;
    if (this.messages.some((m) => m.id === id)) return;
    this.#legacyMessages.push({
      id,
      role: "thinking",
      text: "",
      status: "running",
      agent: this.focusedAgent,
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
    this.#legacyMessages.push({
      id,
      role: "thinking",
      text: delta,
      status: "running",
      agent: this.focusedAgent,
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
    this.#legacyMessages.push({
      id,
      role: "thinking",
      text: "",
      status: "done",
      agent: this.focusedAgent,
      blockId,
      ts: Date.now(),
    });
  }

  async loadAgentTurns(agent: string): Promise<void> {
    // User-reported bug: navigating to /tickets and back to chat shows
    // an empty transcript until the user clicks another agent and
    // returns. Root cause: this method always clears `messages`, even
    // on re-entry to the same agent. The Zero binder short-circuits
    // (`bindBlocksFor` is a no-op when already bound to the same
    // agent), so no fresh `applyZeroBlocks` fires to re-populate the
    // cleared array — until the next Zero update, which may not come
    // for minutes.
    //
    // Cross-agent isolation is now structural: the `messages` derivation
    // filters legacy entries by agent tag and overlay entries by agent
    // + session, and applyZeroBlocks's merge drops cross-agent legacy
    // entries during the per-snapshot rebuild. The pre-rewrite
    // `switchingAgents` reset block here was structurally broken — the
    // caller updates `chat.focusedAgent` BEFORE calling loadAgentTurns,
    // so `this.focusedAgent !== agent` was always false and the previous
    // agent's entries leaked into the new view.
    //
    // Per-agent state items (pagination cursor / Zero snapshot tracker
    // / REST loading flag / SSE dedup cursor) still need to reset on
    // every call so a stale value from the previous agent can't trip
    // the new one. Re-entry to the same agent loses pagination position;
    // that's the acceptable trade-off for the cross-agent leak the
    // previous gating couldn't prevent.
    this.resetChatWindowToLatest();
    this.oldestBlockId = null;
    this.reachedOldest = false;
    this.historyError = null;
    this.zeroBlocksActive = false;
    this.zeroSeenBlockIds = new Set();
    this.lastMarkedBlockIdByAgent.delete(agent);
    this.loadingOlder = false;
    // FRI-55: reset the SSE dedup cursor for this agent so the daemon's
    // turn-buffer replay on SSE reconnect can recreate thinking bubbles
    // that `acceptEvent` would otherwise drop as already-seen.
    delete this.lastSeqByAgent[agent];
    saveJSON(ChatState.LAST_SEQ_KEY, this.lastSeqByAgent);

    // Last-known transcript from a previous session. Render the cached
    // blocks immediately so a slow / offline first-paint doesn't show an
    // empty chat. The live fetch below replaces this once it lands; the
    // bubble ids are stable across cache → fresh (parseBlocks uses
    // userBlockIdForTurn for user blocks and b_<blockId> for assistant),
    // so any in-flight SSE deltas attach cleanly.
    const cachedRaw = loadJSON<BlockRow[]>(KEYS.transcript(agent), []);
    // Apply the same session filter `applyZeroBlocks` uses, so the
    // first-paint cache can't bleed prior sessions onto the screen
    // post-`/clear`. The cache pre-dates Zero (its only writer is the
    // legacy REST path, dormant in the Zero era), so stored blocks
    // span whatever sessions were active when the entry was written —
    // they need scoping at load time the same way live Zero rows do.
    const cached = filterRowsToCurrentSession(
      cachedRaw,
      agent,
      this.agents,
      this.inflightTurnIdByAgent[agent] ?? null,
    );
    // FRI-54: derive once so both parseBlocks call sites below can pass
    // the DB-backed working signal without re-scanning agents twice.
    const agentIsWorking = this.agents.find((a) => a.name === agent)?.status === "working";
    if (cached.length > 0) {
      this.#legacyMessages = [
        ...parseBlocks(cached, agent, {
          inflightTurnId: this.inflightTurnIdByAgent[agent] ?? null,
          agentWorking: agentIsWorking,
        }),
      ];
      // Only seed the scroll-back cursor from cached blocks when Zero
      // is OFF. With Zero on, the cached cursor is stale — new rows
      // may have landed in Postgres since the cache was last saved —
      // and a premature `loadOlderTurns` triggered by a fast scroll
      // would call `?before=<cached-oldest>` and silently mark
      // `reachedOldest=true` if that cursor points to the literal
      // oldest row, hiding any rows between the cached cursor and the
      // Zero window from REST scroll-back forever. `applyZeroBlocks`
      // sets `oldestBlockId` from the Zero snapshot as soon as it
      // arrives; the IntersectionObserver short-circuits while
      // `oldestBlockId === null`.
      if (!this.blocksBinder) {
        this.oldestBlockId = oldestBlockCursor(cached);
      }
    }

    this.loadingInitial = cached.length === 0;

    // Phase 3.7: when Zero is enabled, the per-agent blocks reactive
    // query is the source of truth for chat history. We still fall back
    // to the cached-transcript first-paint above (so a cold reload with
    // an unhealthy WS doesn't show an empty chat). The binder is wired
    // by `zero.svelte.ts` during module init — when it's null, Zero is
    // disabled and we take the REST path below.
    if (this.blocksBinder) {
      this.blocksBinder(agent);
      // The inflightTurnId probe + heal sweep at the end of this function
      // still needs to run — it depends on `messages` being populated, and
      // the binder's first snapshot arrives asynchronously via the
      // `onBlocksUpdate` listener registered by zero.svelte.ts (which
      // calls back into `applyZeroBlocks`). The probe block below races
      // the first snapshot, which is fine: applyZeroBlocks merges (it
      // doesn't wholesale-replace), so the heal sweep's status flips are
      // preserved across the Zero update. Skip the REST init fetch.
    } else {
      try {
        // FIX_FORWARD 3.8: client-picked initial page size based on viewport
        // + network class. Server clamps to ≤200 regardless.
        const limit = initialPageSize();
        const r = await fetchWithTimeout(`/api/agents/${agent}/blocks?limit=${limit}`, {
          timeoutMs: 15_000,
        });
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
        };
        if (this.focusedAgent !== agent) return;
        const blocks = payload.blocks ?? [];
        this.#legacyMessages = parseBlocks(blocks, agent, {
          inflightTurnId: this.inflightTurnIdByAgent[agent] ?? null,
          agentWorking: agentIsWorking,
          noResponseGraceUntil: this.noResponseGraceUntil,
          reconnectGraceUntil: this.reconnectGraceUntil,
          zeroBlockReasonByTurn: this.zeroBlockReasonByTurn,
          now: Date.now(),
        });
        this.oldestBlockId = oldestBlockCursor(blocks);
        // FRI-125: the REST-payload `lastEventSeq` seed of
        // `lastSeqByAgent` retired alongside the row's last_event_seq
        // column. The cursor is now seeded exclusively from SSE event
        // seqs at apply time (see `acceptEvent`), which is still
        // load-bearing for the transient-reconnect dedup case (see
        // ADR-024 amendment).
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
    }

    // Restore `inflightTurnId` so the Send button correctly shows Stop on
    // reload-during-turn. Without this, a hard refresh while the daemon
    // is mid-turn leaves the UI claiming the agent is idle even though
    // SSE deltas may still arrive. The probe is best-effort: on network
    // failure, `inflightTurnId` stays null and the next `turn_started`
    // SSE frame populates it.
    if (this.focusedAgent !== agent) return;
    try {
      const ar = await fetchWithTimeout(`/api/agents/${encodeURIComponent(agent)}`, {
        timeoutMs: 5_000,
      });
      if (!ar.ok) {
        // FRI-81 PR #22 review B1: probe failed with a non-2xx. We don't
        // have authoritative idle/working, but if a prior turn_started SSE
        // already populated an inflight slot, we can still preserve THAT
        // turn's bubbles and heal the rest. With no recoverable inflight,
        // bail — `classifyOrphanRows` already handled the heuristic
        // cases in parseBlocks and SSE `turn_started` will catch up.
        const cachedInflight = this.inflightTurnIdByAgent[agent] ?? null;
        if (cachedInflight) {
          healOrphanStreamingBubbles(this.messages, "preserve-active", cachedInflight);
        }
        return;
      }
      if (this.focusedAgent !== agent) return;
      const entry = (await ar.json()) as { status?: string };
      if (entry.status !== "working") {
        // FRI-81 D2/D3: agent is idle, so any streaming/running bubble
        // we just rendered from the DB is, by definition, an orphan that
        // parseBlocks's heuristic couldn't catch (single-turn history
        // where no later turn exists to demote the streaming row).
        // Convergence sweep — flip them to aborted so the user doesn't
        // see a pulsing "Thinking…" or "running" tool for a turn the
        // worker has already given up on.
        healOrphanStreamingBubbles(this.messages, "all-stale", null);
        return;
      }
      // Find the most recent bubble carrying a turnId from the *response*
      // turn — that's the in-flight turn the daemon will emit `turn_done`
      // for. Skip user bubbles whose `source` produces a non-response
      // turn_id (mail blocks carry `turn_id=mail_<N>`, scratch/schedule/
      // spawn/refork all have their own conventions). If we picked one
      // of those, `markInflight` would write the wrong slot value and a
      // later `turn_done` (for the actual response turn) would fail to
      // match — leaving the running animation stuck forever (FRI-72).
      // Assistant bubbles always carry the response turn_id. A
      // `user_chat`-sourced user bubble also matches the response turn
      // (recordUserBlock uses the same turn_id for both).
      let latestTurnId: string | undefined;
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const m = this.messages[i];
        if (!m.turnId) continue;
        if (m.role === "user" && m.source && m.source !== "user_chat") continue;
        latestTurnId = m.turnId;
        break;
      }
      // If no usable turnId is recoverable (only mail/scratch/etc. user
      // bubbles in view), leave the slot null and let SSE replay's
      // `turn_started` populate it — that's the authoritative signal.
      // FRI-81 PR #22 review B2: must also skip the heal sweep here —
      // calling it with a null active turn would flip every streaming
      // bubble to aborted, including the genuinely-live one the daemon
      // is about to emit deltas for. Bail and trust SSE.
      if (latestTurnId) {
        this.markInflight(agent, latestTurnId);
        // FRI-81 D2/D3: even when the agent is mid-turn, every streaming
        // bubble outside the active turn is an orphan. Heal them now —
        // the active turn's bubbles stay streaming so SSE deltas continue
        // to attach.
        healOrphanStreamingBubbles(this.messages, "preserve-active", latestTurnId);
      }
    } catch {
      // FRI-81 PR #22 review B1: probe threw (network/timeout). Same as
      // the !ar.ok branch above — if we already have an inflight slot
      // from a prior SSE turn_started, preserve it and heal the rest.
      // No inflight known → conservative bail.
      const cachedInflight = this.inflightTurnIdByAgent[agent] ?? null;
      if (cachedInflight) {
        healOrphanStreamingBubbles(this.messages, "preserve-active", cachedInflight);
      }
    }
  }

  /**
   * Phase 3.7: Merge a fresh snapshot of Zero rows for `forAgent` into
   * `this.messages`. Called by the listener `zero.svelte.ts` registers
   * via `onBlocksUpdate` after each materialize/listener frame. Idempotent
   * on the same row set.
   *
   * Contract:
   *   - If the focused agent no longer matches `forAgent` (race: user
   *     switched chat windows between rebind and snapshot), bail without
   *     mutating state.
   *   - Convert snake_case Zero rows to the camelCase `BlockRow` shape
   *     `parseBlocks` expects; run parseBlocks to derive bubbles.
   *   - Merge by `id` (parseBlocks's bubble ids are stable across reload
   *     vs. live SSE — `b_<blockId>` / `userBlockIdForTurn(turnId)` /
   *     `t_<toolId>`). Existing bubbles are replaced by their parsed
   *     counterparts; bubbles in `messages` with no Zero match (in-flight
   *     SSE streams, queue-synth, optimistic pending, scroll-back rows
   *     outside the 50-row Zero window) are preserved.
   *   - Drop superseded no-response *safety-net* bubbles (where parseBlocks
   *     emitted `nr_<turnId>` for a turn but later assistant content
   *     landed for the same turnId). Race-prone window: user message lands
   *     in Zero before the first assistant block does. Sentinel-driven
   *     no-response bubbles (`noResponseSentinel: true`) are authoritative
   *     and never dropped.
   *   - Update `oldestBlockId` to the lowest Zero row's blockId for
   *     REST scroll-back continuation.
   *
   * `lastSeqByAgent` is no longer seeded from Zero rows (FRI-125: the
   * row's `last_event_seq` column retired). The cursor is fed
   * exclusively from SSE event seqs at apply time in `acceptEvent`,
   * which is still load-bearing for the transient-reconnect dedup case
   * — see ADR-024's amended cursor-retires bullet.
   *
   * The `streaming=true` rows are pre-filtered by the Zero query
   * (`bindBlocksFor` adds `where('status', '!=', 'streaming')`), so any
   * row arriving here is canonical. In-flight content lives only in the
   * SSE-driven overlay until the daemon flips the row to `complete`.
   */
  applyZeroBlocks(
    rows: readonly ZeroBlocksRow[],
    forAgent: string,
    resultType: "complete" | "unknown" | "error" = "unknown",
    fullWindow: boolean = true,
  ): void {
    if (this.focusedAgent !== forAgent) return;
    // Defer the entire snapshot if we don't yet know which session
    // this agent is on. Zero's `agents` and `blocks` slices materialize
    // independently — on a cold reload the blocks listener routinely
    // fires before the agents query has replicated, and without this
    // gate the session filter would have nothing to scope against
    // (the prior permissive fallback rendered the whole agent-scoped
    // snapshot, which leaked the just-cleared session back onto the
    // screen). The agents listener in `zero.svelte.ts` re-fires
    // `applyZeroBlocks` for the focused agent once the row replicates,
    // so this early return self-heals.
    if (!this.agents.some((a) => a.name === forAgent)) return;
    this.zeroBlocksActive = true;
    this.loadingInitial = false;

    // Plan §39 phase 2 completion signal: when Zero confirms the local
    // replica matches the upstream filter (`resultType === 'complete'`),
    // there are no older rows the server has but the client hasn't
    // received — `reachedOldest` is honest. While the result is still
    // `'unknown'` (initial bootstrap streaming in), the UI keeps any
    // existing "load more" affordance as a no-op spinner; the next
    // snapshot frame will either bring more rows or flip to 'complete'.
    //
    // FRI-161: `complete` on the NARROW cold-start window only means the
    // last 2 days are synced — NOT that the user has reached the oldest
    // message. Gate on `fullWindow` so "Beginning of history" never lies
    // mid-backfill. The wider bind re-fires this with fullWindow=true once
    // `#widenForegroundWindow` runs, flipping `reachedOldest` honestly then.
    if (resultType === "complete" && fullWindow) this.reachedOldest = true;

    // The live chat view is the agent's CURRENT session. See
    // `filterRowsToCurrentSession`.
    rows = filterRowsToCurrentSession(
      rows,
      forAgent,
      this.agents,
      this.inflightTurnIdByAgent[forAgent] ?? null,
    );

    if (rows.length === 0) {
      // Empty agent (no history yet) OR a just-cleared session whose
      // first user block hasn't landed yet. Preserve queue-synth + any
      // in-flight bubbles already in `messages` — `clearLocalView` is
      // responsible for the explicit wipe at `/clear` time; this branch
      // must not mutate `messages` because it also runs for an honest
      // fresh-agent state where the optimistic bubble from `addUser` is
      // the only thing the user sees until the canonical row replicates.
      // FRI-161: same fullWindow gate as the main-body writer above — a
      // narrow-window 'complete' is not "reached oldest".
      if (resultType === "complete" && fullWindow) this.reachedOldest = true;
      return;
    }

    // Capture the cursor's PRIOR value before the merge so the core computes
    // `oldestCursorChanged` against it (fix #3) instead of a post-assignment
    // value — comparing after the assignment would make the check always false
    // and silently break scroll-back pagination.
    const priorOldestBlockId = this.oldestBlockId;
    // The genuine convergence (parse + merge loop + dropSuperseded compose +
    // cursors) is the pure core; the shell keeps the gates, the $state
    // pre-sets, the session filter + empty-rows branch (above), and the
    // write-backs (below). `rows` is already session-filtered.
    const result = mergeZeroSnapshot({
      rows,
      forAgent,
      agents: this.agents,
      inflightTurnId: this.inflightTurnIdByAgent[forAgent] ?? null,
      legacyMessages: this.#legacyMessages,
      zeroSeenBlockIds: this.zeroSeenBlockIds,
      noResponseGraceUntil: this.noResponseGraceUntil,
      reconnectGraceUntil: this.reconnectGraceUntil,
      zeroBlockReasonByTurn: this.zeroBlockReasonByTurn,
      resultType,
      fullWindow,
      priorOldestBlockId,
      // Clock pinned here at the IO boundary; the core stays deterministic.
      now: Date.now(),
    });

    // Update the seen tracker AFTER consuming the result (gotcha 1) so the
    // core's delete-detection compared against the PRIOR seen-set; the next
    // snapshot recognizes these block_ids as "seen via Zero".
    for (const bid of result.snapshotBlockIds) this.zeroSeenBlockIds.add(bid);

    this.#legacyMessages = result.nextLegacyMessages;

    // Overlay companion to the in-merge snapshotBlockIds drop: drop any
    // optimistic overlay entry whose queueId just appeared as a canonical Zero
    // row this snapshot. Without it the pending_<uuid> overlay entry and the
    // canonical legacy entry would surface as two distinct ids for one text.
    if (result.snapshotBlockIds.size > 0) {
      for (const [key, entry] of this.optimistic.entries()) {
        if (entry.queueId && result.snapshotBlockIds.has(entry.queueId)) {
          // FRI-139: cancel any armed transport-failure fallback for this
          // queueId — the canonical row arrived, the bubble is about to
          // disappear, and a stale timer firing later would flip a
          // non-existent entry's `failed` flag.
          this.clearTransportFailureTimer(entry.queueId);
          this.optimistic.delete(key);
        }
      }
    }
    // Reload-heal convergence: drop streaming overlay entries whose canonical
    // row just landed in legacy at a terminal status. Runs over a snapshot,
    // OUTSIDE any derivation (see pruneConverged's doc).
    this.pruneConvergedStreamingOverlay(forAgent);

    // reachedOldest two-writer (fix #3): the pre-merge `$state` pre-set above
    // is the set-true writer (gated on resultType complete && fullWindow);
    // here the cursor-shift false-writer re-arms pagination so rows between a
    // stale cursor and the new Zero window stay reachable. `oldestCursorChanged`
    // was computed in the core against `priorOldestBlockId`, so this is
    // independent of the assignment order below. (`result.reachedOldest`
    // mirrors the pre-set's condition and is asserted by the pure test.)
    if (result.oldestCursorChanged) this.reachedOldest = false;
    this.oldestBlockId = result.newOldestCursor;

    // FRI-125: `lastSeqByAgent` is seeded exclusively from SSE event seqs at
    // apply time (`acceptEvent`), not from Zero rows.

    // Phase 4.1: advance the per-device read cursor to the newest snapshot row
    // ("if you're looking at it, you've seen it"). The mutator is idempotent on
    // the (device, agent, block) PK; the `lastMarkedBlockIdByAgent` memo dedups
    // the redundant push client-side. The core picked the newest by (ts, id)
    // tuple (Phase 4.11's mixed numeric/UUID alphabet defeats a bare lexical
    // id compare — see `oldestBlockCursor`).
    if (this.markReadFn && result.newestRowForReadCursor) {
      const newest = result.newestRowForReadCursor;
      const prev = this.lastMarkedBlockIdByAgent.get(forAgent);
      if (prev !== newest.block_id) {
        this.lastMarkedBlockIdByAgent.set(forAgent, newest.block_id);
        this.markReadFn(forAgent, newest.block_id);
      }
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
    // Plan §39 local-first contract: when the Zero binder owns the
    // blocks path, the local IndexedDB replica already holds every
    // block within the 90-day retention window. Scroll-up reads from
    // `this.messages` (already populated by `applyZeroBlocks`); there
    // is no network round-trip. While Zero's initial materialization
    // is still streaming in (`blocksResultType === 'unknown'`),
    // applyZeroBlocks will append additional rows as they arrive —
    // no manual pagination needed. The legacy REST `?before=` path
    // remains below only as the no-Zero fallback (SSR / disabled).
    if (this.blocksBinder) {
      this.reachedOldest = this.reachedOldest || false;
      return;
    }
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
      const older = parseBlocks(blocks, agent, {
        inflightTurnId: this.inflightTurnIdByAgent[agent] ?? null,
        noResponseGraceUntil: this.noResponseGraceUntil,
        now: Date.now(),
      });
      // FRI-81 D2/D3: older history is, by definition, from past turns —
      // no streaming/running bubble in this page is the active turn. Heal
      // them eagerly (the parseBlocks heuristic doesn't see the current
      // chat's blocks so it can't tell on its own). If we have a known
      // inflight, preserve that turn's bubbles; otherwise flip all.
      const cachedInflight = this.inflightTurnIdByAgent[agent] ?? null;
      healOrphanStreamingBubbles(
        older,
        cachedInflight ? "preserve-active" : "all-stale",
        cachedInflight,
      );
      // Prepend, dedup-by-id (SSE may have surfaced something we now also
      // see in DB).
      const seen = new Set(this.messages.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      this.#legacyMessages = [...fresh, ...this.#legacyMessages];
      this.oldestBlockId = oldestBlockCursor(blocks);
      opts?.onPrepended?.();
    } catch {
      // ignore
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < MIN_LOADING_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_LOADING_MS - elapsed));
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
      "agent" in event && typeof event.agent === "string" ? event.agent : SYSTEM_BUCKET;
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
      case "block_canceled":
        if (event.agent !== this.focusedAgent) break;
        this.handleBlockCanceled(event);
        break;
      // Phase 5: `block_meta_update` + `block_reload` retired.
      // Zero replicates the underlying blocks-table UPDATEs/INSERTs
      // (queued → complete, aborted-then-deleted, JSONL-recovery
      // inserts) reactively into the dashboard's `applyZeroBlocks`
      // path — no SSE consumer or REST refetch needed.
      case "turn_done":
        // FRI-12: always clear the per-agent inflight slot for this
        // turn — quarantine of inflight state is global state and must
        // not be gated on focus, otherwise switching to a non-focused
        // agent leaks the wedge indicator. The bubble-status walk
        // below stays focus-gated because chat.messages only holds the
        // focused agent's bubbles.
        this.clearInflightForTurn(event.turn_id);
        // FRI-156 §F terminal-fallback: a worker that dies / aborts / OOMs
        // mid-compaction emits no `compacting` phase:'done' frame, so the Set
        // entry would otherwise stick and wedge the spinner on until reload.
        // A turn_done for the agent is the unambiguous "this turn ended"
        // signal — clear any compaction entry for it. Global (not focus-gated)
        // for the same reason the inflight clear is.
        this.compactingAgents.delete(event.agent);
        if (event.agent !== this.focusedAgent) break;
        // FRI-60: store zero_block_reason so parseBlocks can attach the right
        // copy to the synthesized no-response bubble.
        if (event.zero_block_reason) {
          this.zeroBlockReasonByTurn[event.turn_id] = event.zero_block_reason;
        }
        // FRI-95: thread abort_reason through so the user-block bubble can
        // distinguish "Stopped" (cooperative) from "Stopped — worker had
        // to be force-killed" (forced).
        this.finishTurn(event.turn_id, event.status, event.abort_reason);
        break;
      case "compacting":
        // FRI-156 §F: transient compaction-in-progress signal. `phase:'start'`
        // sets the live "Compacting context…" indicator; `phase:'done'`
        // clears it (the durable divider — written as a kind:'compaction'
        // block and replicated via Zero — is the settled artifact, handled
        // in parseBlocks, NOT here). Tracked per-agent in a Set so two agents
        // compacting at once (nightly sweep) don't clobber one another's
        // spinner; the focus gate lives in `focusedAgentIsCompacting`. This
        // replaces the retired `type:'compaction'` event + `compactionTurnIds`
        // Set + inline `.compaction-notice` (FRI-60 Phase B), which were
        // in-memory-only and lost on reload.
        if (event.phase === "start") {
          this.compactingAgents.add(event.agent);
        } else {
          this.compactingAgents.delete(event.agent);
        }
        break;
      case "error":
        // Same per-agent quarantine: clear the slot for this turn even
        // when the event is for a non-focused agent.
        if (event.turn_id) this.clearInflightForTurn(event.turn_id);
        // FRI-156 §F terminal-fallback: an error ends the turn; clear any
        // stale compaction spinner entry so a mid-compaction failure that
        // never sent phase:'done' can't wedge it on (see turn_done above).
        this.compactingAgents.delete(event.agent);
        if (event.agent !== this.focusedAgent) break;
        if (event.turn_id) this.finishTurn(event.turn_id, "error");
        break;
      // Phase 5: `agent_lifecycle` + `agent_status` SSE retired.
      // Zero's `agents` slice (Phase 2) mirrors into `chat.agents`
      // via the `#bindAgents` listener in zero.svelte.ts; the
      // dashboard sidebar gets spawn / archive / idle / working
      // status reactively without these SSE handlers.
      case "agent_message":
        // FIX_FORWARD 3.6: badge unfocused agents on new user-visible
        // block_complete. The focused agent never accumulates a badge —
        // the user is already reading the chat.
        if (event.agent !== this.focusedAgent) {
          this.bumpUnread(event.agent);
        }
        break;
      // Phase 5: `mail_delivered` SSE retired. Zero replicates the
      // `mail` slice (Phase 3.6); the recipient's badge is bumped
      // by the eventual assistant `agent_message` SSE — same
      // F3-B PR C behavior, just with the redundant nudge gone.
      default:
        break;
    }
  }

  /* ------------ Block-level streaming handlers (FIX_FORWARD 1.7) ------------ */

  /** Reload-heal convergence: drop streaming overlay entries for `agent`
   *  whose canonical row exists in the legacy bucket at a terminal
   *  status. While the row was in-flight the overlay shadowed the
   *  legacy entry; once the canonical row carries the terminal status
   *  the overlay no longer adds anything. Called from applyZeroBlocks
   *  on every snapshot so the overlay drains as Zero finalizes blocks
   *  for the focused agent. */
  private pruneConvergedStreamingOverlay(agent: string): void {
    if (this.streaming.size === 0) return;
    // Partition over an eager snapshot of the overlay, OUTSIDE any reactive
    // scope (pruneConverged reads legacy `status`; see its doc), then apply
    // the converged drops. `overlayKey(e.agent, e.id)` reconstructs the exact
    // insertion key, so this deletes the same entries the inline scan did.
    const { drop } = pruneConverged(this.#legacyMessages, [...this.streaming.values()], agent);
    for (const e of drop) this.streaming.delete(overlayKey(e.agent, e.id));
  }

  /** Find the overlay tool entry matching a SSE block_id. Tool overlay
   *  entries are keyed by `t_<toolId>` rather than `b_<blockId>` — we
   *  need a scan-by-blockId for `input_json_delta` routing. Cost is
   *  bounded by streaming.size (typically 1-3 entries during a turn). */
  private findStreamingByBlockId(agent: string, blockId: string): StreamingEntry | undefined {
    for (const entry of this.streaming.values()) {
      if (entry.agent !== agent) continue;
      if (entry.blockId === blockId) return entry;
    }
    return undefined;
  }

  private handleBlockStart(event: {
    block_id: string;
    block_index: number;
    role: string;
    // FRI-156: widened to the shared BlockKind (now includes 'mail' +
    // 'compaction') so the SSE BlockStartEvent type assigns. The daemon
    // never streams block_start frames for 'mail'/'compaction' (mail goes
    // through recordUserBlock, compaction through the durable Zero block),
    // so the kind-branching below simply falls through for them.
    kind: BlockKind;
    turn_id: string;
    tool?: { id: string; name: string };
    ts: number;
  }): void {
    // FRI-12: error blocks ship as a fused start+complete pair from the
    // daemon. We materialize the bubble on `block_complete` only — the
    // start carries no useful metadata and would push an empty placeholder.
    if (event.kind === "error") return;
    const agent = this.focusedAgent;
    const sid = this.currentSessionFor(agent);
    if (event.kind === "text") {
      const role = event.role === "user" ? "user" : "assistant";
      // FIX_FORWARD 2.6: user blocks key by turn_id so the local pending
      // bubble (re-keyed on POST-success) and the canonical block from the
      // daemon converge on the same row.
      const id = role === "user" ? userBlockIdForTurn(event.turn_id) : `b_${event.block_id}`;
      if (this.messages.some((m) => m.id === id)) return;
      if (role === "user") {
        // User-block path stays on the legacy bucket — addUser + the
        // optimistic overlay cover user_chat; this branch handles
        // mail / scratch / scheduled blocks that bypass addUser.
        this.#legacyMessages.push({
          id,
          role,
          text: "",
          status: "complete",
          agent,
          turnId: event.turn_id,
          ts: event.ts,
        });
        return;
      }
      // Assistant text: streaming overlay. The StreamingEntry's per-field
      // $state keeps subsequent block_delta `entry.text += delta`
      // mutations fine-grained — the `messages` derivation does not
      // re-run on text growth.
      this.streaming.set(
        overlayKey(agent, id),
        new StreamingEntry({
          id,
          role: "assistant",
          agent,
          ts: event.ts,
          turnId: event.turn_id,
          blockId: event.block_id,
          sessionId: sid,
          initialStatus: "streaming",
        }),
      );
      return;
    }
    if (event.kind === "thinking") {
      const id = `th_${event.block_id}`;
      if (this.messages.some((m) => m.id === id)) return;
      this.streaming.set(
        overlayKey(agent, id),
        new StreamingEntry({
          id,
          role: "thinking",
          agent,
          ts: event.ts,
          turnId: event.turn_id,
          blockId: event.block_id,
          sessionId: sid,
          initialStatus: "running",
        }),
      );
      return;
    }
    if (event.kind === "tool_use") {
      const toolId = event.tool?.id ?? event.block_id;
      const id = `t_${toolId}`;
      if (this.messages.some((m) => m.id === id)) return;
      this.streaming.set(
        overlayKey(agent, id),
        new StreamingEntry({
          id,
          role: "tool",
          agent,
          ts: event.ts,
          turnId: event.turn_id,
          blockId: event.block_id,
          sessionId: sid,
          toolId,
          initialStatus: "running",
          initialToolName: event.tool?.name ?? "",
        }),
      );
      return;
    }
    // tool_result: created lazily on block_complete (we need content_json
    // to know which tool_use_id it belongs to).
  }

  private handleBlockDelta(event: {
    block_id: string;
    delta: { text?: string; partial_json?: string };
  }): void {
    const agent = this.focusedAgent;
    const textId = `b_${event.block_id}`;
    const thinkId = `th_${event.block_id}`;

    // Text deltas: prefer the streaming overlay. `entry.text += delta`
    // fires fine-grained reactivity on `entry.text` only — the
    // `messages` derivation does not re-run, so paint stays bounded
    // by the bubble's own text-node update.
    if (typeof event.delta.text === "string") {
      const textEntry = this.streaming.get(overlayKey(agent, textId));
      if (textEntry && textEntry.role === "assistant") {
        if (textEntry.status === "streaming") textEntry.text += event.delta.text;
        return;
      }
      const thinkEntry = this.streaming.get(overlayKey(agent, thinkId));
      if (thinkEntry && thinkEntry.role === "thinking") {
        if (thinkEntry.status === "running") thinkEntry.text += event.delta.text;
        return;
      }
    }
    if (typeof event.delta.partial_json === "string") {
      const toolEntry = this.findStreamingByBlockId(agent, event.block_id);
      if (toolEntry && toolEntry.role === "tool") {
        if (toolEntry.status === "running") {
          toolEntry.inputPartialJson =
            (toolEntry.inputPartialJson ?? "") + event.delta.partial_json;
        }
        return;
      }
    }

    // Legacy fallback: a delta whose block_start landed before the
    // overlay migration (or for ids only the legacy bucket holds —
    // tests using `chat.startAssistantTurn` / `chat.appendDelta` push
    // directly to legacy without going through SSE; also reload-mid-
    // stream Zero rows at status='streaming' that landed before SSE
    // caught up).
    for (let i = this.#legacyMessages.length - 1; i >= 0; i--) {
      const m = this.#legacyMessages[i];
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
      // FRI-84: accumulate input_json_delta fragments on the tool bubble
      // so the ToolBlock can render the live input under the headline
      // during streaming. block_start for tool_use keys the bubble by
      // `t_<toolId>` rather than block_id, so we match on role+blockId.
      if (
        m.role === "tool" &&
        m.blockId === event.block_id &&
        m.status === "running" &&
        typeof event.delta.partial_json === "string"
      ) {
        m.inputPartialJson = (m.inputPartialJson ?? "") + event.delta.partial_json;
        return;
      }
    }
  }

  private handleBlockComplete(event: {
    block_id: string;
    // FRI-156: widened to the shared BlockKind (see handleBlockStart). The
    // 'mail'/'compaction' kinds never arrive via SSE block_complete frames;
    // the kind-branching below falls through for them.
    kind: BlockKind;
    content_json: string;
    status: "complete" | "aborted" | "error" | "queued";
    turn_id: string;
    role: string;
    source: string | null;
    ts: number;
  }): void {
    // Resolve the SSE frame into one discriminated plan against a snapshot of
    // the read surface, then apply it. The merge logic (overlay-first
    // precedence, in-place backfills, late-mount, FRI-85 sentinel, FRI-81 D4
    // ghost-drop) lives in `reconcileComplete`; the shell only mutates state.
    const agent = this.focusedAgent;
    const snapshot: ReconcileSnapshot = {
      // `this.messages` (the derived view) folds in overlay+optimistic+session
      // filter and carries the live object references the `inplace` plan
      // patches. Snapshotted once: nothing below mutates state before the plan
      // is computed, so a single read is equivalent to the old lazy re-reads.
      merged: this.messages,
      overlay: this.streaming,
      focus: { agent, sessionId: this.currentSessionFor(agent) },
    };
    const plan = reconcileComplete(snapshot, event);
    switch (plan.kind) {
      case "overlay-finalize": {
        // Re-fetch the overlay entry by key — synchronous, so it is the same
        // entry `reconcileComplete` inspected. Object.assign fires the
        // StreamingEntry's per-field $state setters (text/status/etc).
        const entry = this.streaming.get(plan.key);
        if (entry) Object.assign(entry, plan.patch);
        return;
      }
      case "inplace":
        // fix #5: patch the live merged-view object the plan matched directly
        // (it may be an overlay/optimistic entry, not a #legacyMessages
        // member — re-finding by id in legacy alone would silently no-op).
        Object.assign(plan.target, plan.patch);
        return;
      case "legacy-push":
        this.#legacyMessages.push(plan.row);
        return;
      case "no-response": {
        this.streaming.delete(plan.overlayKeyToDelete);
        const idx = this.#legacyMessages.findIndex((m) => m.id === plan.legacyIdToSplice);
        if (idx !== -1) this.#legacyMessages.splice(idx, 1);
        if (plan.pushRow) this.#legacyMessages.push(plan.pushRow);
        return;
      }
      case "ghost-drop":
        this.streaming.delete(plan.overlayKeyToDelete);
        this.#legacyMessages = this.#legacyMessages.filter((m) => m.id !== plan.legacyIdToFilter);
        return;
      case "noop":
        return;
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
  /**
   * FRI-78 follow-up: the daemon DELETEd a block that started but never
   * accumulated content (typically an SDK-opened `thinking` block that
   * the worker's `flushBoundaryBlocks` cancelled at a pending-injection
   * break). Drop any bubble currently mounted against that block id so
   * the UI doesn't show a "Stopped" footer for a block that had nothing
   * to disclose.
   */
  private handleBlockCanceled(event: { block_id: string }): void {
    // Agent-agnostic (fix #4): drop every overlay entry AND legacy bubble
    // mounted against this block id, across all agents. `reconcileCanceled`
    // matches overlay entries by blockId and reconstructs their exact map
    // keys (overlayKey(agent, id)); the legacy filter is likewise untagged.
    const { nextLegacy, dropKeys } = reconcileCanceled(
      this.#legacyMessages,
      [...this.streaming.values()],
      event.block_id,
    );
    for (const key of dropKeys) this.streaming.delete(key);
    this.#legacyMessages = nextLegacy;
  }

  // Phase 5: `handleBlockMetaUpdate` removed — Zero replicates the
  // queued → complete UPDATEs (and aborted DELETEs) on the blocks
  // table; `applyZeroBlocks` re-derives the message list via
  // `parseBlocks` which re-sorts by ts.
}

export const chat = new ChatState();

// Dev probe: expose the singleton on `window` so devtools and Playwright
// probes can read/drive its state without re-importing the module (Vite
// gives each import path its own instance, defeating in-page inspection).
// Mirrors `__fridayZero` in zero.svelte.ts. The FRI-72 send-target e2e
// spec uses this to force the `focusedAgent`-lags-URL race deterministically.
if (typeof window !== "undefined") {
  (globalThis as unknown as { __fridayChat?: ChatState }).__fridayChat = chat;
}

/**
 * FRI-81 D2/D3 (companion to `classifyOrphanRows`): heal any
 * `streaming`/`running` bubble whose turnId is NOT the focused agent's
 * current inflight turn. Called from `loadAgentTurns` after the
 * `/api/agents/:name` probe resolves — by that point we know
 * authoritatively whether the agent is mid-turn.
 *
 * Two modes — caller must be explicit, because passing the wrong one
 * silently kills live bubbles (see FRI-81 PR #22 review B2):
 *
 *   - `"all-stale"`: agent is idle (or we have authoritative "no turn
 *     is active" signal). Every streaming/running bubble is, by
 *     definition, stale; flip all to aborted.
 *
 *   - `"preserve-active"`: agent is working on `activeTurnId`. Flip
 *     every streaming/running bubble EXCEPT those carrying that turnId
 *     so SSE deltas keep attaching to the live ones.
 *
 * On probe failure or any path where the caller doesn't have a
 * definitive answer ("working but I can't recover the turnId"), DO NOT
 * call this function — let SSE `turn_started` catch up. The
 * conservative default is "don't touch live bubbles." parseBlocks's
 * `classifyOrphanRows` heuristic already healed the unambiguous cases
 * before this point.
 */
export function healOrphanStreamingBubbles(
  messages: ChatMessage[],
  mode: "all-stale" | "preserve-active",
  activeTurnId: string | null,
): void {
  if (mode === "preserve-active" && !activeTurnId) {
    // Caller bug — defensive bail. The signature lets the caller
    // forget to wrap in `if (latestTurnId)`; refusing to flip
    // anything is the safer failure mode.
    return;
  }
  for (const m of messages) {
    if (m.role === "assistant" && m.status === "streaming") {
      if (mode === "preserve-active" && m.turnId === activeTurnId) continue;
      m.status = "aborted";
    } else if ((m.role === "thinking" || m.role === "tool") && m.status === "running") {
      if (mode === "preserve-active" && m.turnId === activeTurnId) continue;
      m.status = "aborted";
    }
  }
}

/**
 * Test-only hook. The per-turn parseBlocks memoization (the cache itself)
 * was on this branch via commit b3efab5 but was overwritten when the
 * branch reconciled with main's FRI-59 architectural rewrite of the file.
 * The export survives as a no-op so chat.test.ts's beforeEach still
 * compiles; the memoization can be re-introduced as a focused follow-up
 * once the merged baseline lands.
 */
export function __resetParseCache(): void {
  // intentionally empty — placeholder for the per-turn parse cache.
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
    const ms = unit.startsWith("minute")
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
