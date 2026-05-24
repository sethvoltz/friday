import type { WireEvent } from "@friday/shared";
import { SvelteMap } from "svelte/reactivity";
import { fetchWithTimeout } from "../util/fetch-with-timeout";
import { initialPageSize } from "../util/page-size";
import { KEYS, loadJSON, removeKey, saveJSON } from "./persistent";
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
    | "queued"
    // FRI-95: Stop fired on a turn that completed before the abort took
    // effect. Brief 1s transient on the user-block to acknowledge the click
    // without falsely claiming "Stopped". Settles back to "complete".
    | "already_finished";
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
  /** Mid-stream accumulator for `input_json_delta` chunks (FRI-84). The
   *  SDK emits the tool's input as incremental JSON fragments via the
   *  `block_delta` wire event's `partial_json` field; we concatenate them
   *  here so the ToolBlock can render the live input under the headline
   *  during the streaming phase. Cleared on `block_complete` once `input`
   *  is populated from the canonical content_json. Best-effort:
   *  intermediate values may be invalid JSON and the renderer falls back
   *  to raw display. */
  inputPartialJson?: string;

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
   *  Resend / Resume / Details affordances.
   *
   *  When set to `"no-response"`, this bubble is a synthetic
   *  "agent didn't reply" affordance (FRI-85). Emitted either because
   *  the model produced its trained "No response requested." end-of-
   *  turn sentinel (deliberate no-reply) or because the turn finished
   *  with zero assistant-side content blocks (worker died early,
   *  Task-only response, etc.). Replaces FRI-9's silent suppression
   *  so the user is never left staring at their own message wondering
   *  whether the system swallowed the turn. Single bubble per turn
   *  (id `nr_<turnId>`) regardless of which producer wins. */
  kind?: "error" | "no-response";

  /** True when the synthetic no-response bubble was produced by the
   *  SDK sentinel specifically — distinguishes "agent deliberately
   *  decided no reply was needed" (verbose: "Agent acknowledged — no
   *  reply needed") from "turn ended with zero assistant content"
   *  (verbose: "Agent didn't respond"). FRI-85. */
  noResponseSentinel?: boolean;
  errorCode?: string;
  errorHeadline?: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  requestId?: string;
  rawErrorMessage?: string;

  /** FRI-95: set on the user-block message when its turn ends in an
   *  aborted state, so the bubble's terminal footer can distinguish
   *  "Stopped" (cooperative — worker honored the abort cleanly) from
   *  "Stopped — worker had to be force-killed" (forced — the daemon's
   *  500ms deadline elapsed and the worker was SIGTERMed). Sourced from
   *  the daemon's `turn_done.abort_reason` field. Undefined for
   *  non-user-block messages and for turns that didn't end in abort. */
  abortReason?: "cooperative" | "forced";
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
  retrying = $state(false);

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

/** Overlay-map key. Globally unique because message ids (`b_<blockId>`,
 *  `t_<toolId>`, `th_<blockId>`, `u_queue_<qid>`, `userBlockIdForTurn(...)`)
 *  are themselves unique within an agent. */
export type OverlayKey = string;
export function overlayKey(agent: string, id: string): OverlayKey {
  return `${agent}|${id}`;
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

/**
 * Stable bubble id for the synthetic "agent didn't respond" affordance
 * keyed by turn_id (FRI-85). One per turn — both the sentinel-text path
 * and the zero-assistant-content safety-net path converge on the same id
 * so live SSE replacing the streaming bubble and reload reconstructing
 * from blocks produce identical message rows.
 */
export function noResponseIdForTurn(turnId: string): string {
  return `nr_${turnId}`;
}

/**
 * Sentinel session_id the dashboard's `sendUserMessage` mutator writes
 * on user blocks before the daemon has resolved the SDK's real session
 * id. Matches `PENDING_SESSION_SENTINEL` in
 * `packages/shared/src/services/blocks.ts` — duplicated here to keep
 * the client free of a runtime dependency on the daemon-side service
 * module (the constant is used in a hot reactive path).
 */
export const PENDING_SESSION_SENTINEL = "__pending__";

/**
 * Drop rows whose session id doesn't match the focused agent's current
 * SDK session. Used at the two ingest points where multi-session
 * agent-scoped data shows up in the live transcript:
 *
 *   1. {@link ChatState.applyZeroBlocks} — Zero's blocks slice is
 *      agent-scoped, so prior-session rows ride along.
 *   2. {@link ChatState.loadAgentTurns} — the localStorage transcript
 *      cache pre-dates Zero and can contain blocks from whatever
 *      session was active when it was last written.
 *
 * Rows tagged with the `__pending__` sentinel pass through **only if
 * their `turn_id` matches the focused agent's current inflight turn**.
 * The sentinel is the dashboard mutator's "no SDK session yet" marker;
 * the daemon's lifecycle `session-update` sweep rewrites those rows
 * to the real id once the worker announces a session, but the sweep
 * is scoped to a single turn. When a turn dies before its
 * `session-update` arrives (worker SIGTERM, daemon crash, `/clear`
 * mid-turn), the `__pending__` block becomes a historical orphan that
 * the sweep will never claim. Without the turn-id gate the orphan
 * keeps rendering as live content every time the user reloads —
 * which is exactly the "Yesterday at 4:23 PM bug message keeps
 * reappearing post-`/clear`" repro. Gating on `turn_id ===
 * inflightTurn` keeps the just-typed user bubble visible during the
 * brief mutator-write → daemon-sweep window without resurrecting dead
 * orphans.
 *
 * **STRICT contract:** when `agents` does not contain a row for the
 * focused agent, return `[]`. The earlier permissive fallback
 * (return rows unfiltered) was the load-bearing leak behind the
 * post-`/clear` reload bug — Zero's `agents` and `blocks` slices
 * materialize independently, and on a cold reload the `blocks`
 * listener can fire `applyZeroBlocks` before the `agents` query has
 * replicated. With the permissive fallback that meant the prior
 * session's full transcript got rendered in the window between
 * blocks-arriving and agents-arriving. Callers must therefore
 * either ensure `chat.agents` is populated before they invoke the
 * filter, or accept "render nothing yet" and re-invoke once Zero
 * pushes the agents row — see the `#bindAgents` update callback in
 * `zero.svelte.ts` which now re-fires `applyZeroBlocks` for the
 * focused agent whenever `chat.agents` updates.
 *
 * Duck-types over both row shapes — Zero rows expose `session_id` /
 * `turn_id` (snake_case), `BlockRow` exposes `sessionId` / `turnId`
 * (camelCase).
 */
export function filterRowsToCurrentSession<
  T extends {
    sessionId?: string;
    session_id?: string;
    turnId?: string;
    turn_id?: string;
  },
>(
  rows: readonly T[],
  agent: string,
  agents: readonly AgentInfo[],
  currentInflightTurnId: string | null,
): T[] {
  const agentRow = agents.find((a) => a.name === agent);
  if (!agentRow) return [];
  const currentSessionId = agentRow.sessionId;
  return rows.filter((r) => {
    const sid = r.session_id ?? r.sessionId;
    if (sid === undefined) return false;
    if (sid === PENDING_SESSION_SENTINEL) {
      // Only pass the sentinel for rows belonging to the turn the user
      // is actively in. Historical orphans from dead turns that the
      // daemon's session-update sweep will never claim are dropped.
      if (currentInflightTurnId === null) return false;
      const tid = r.turn_id ?? r.turnId;
      return tid === currentInflightTurnId;
    }
    return currentSessionId !== undefined && sid === currentSessionId;
  });
}

export class ChatState {
  /**
   * Pre-migration imperative bucket for the focused agent's chat bubbles.
   *
   * This is the legacy `messages` array, scoped to a private field so the
   * public `messages` getter can layer the streaming / optimistic overlays
   * on top of it. Internal mutators (SSE handlers, optimistic-send path,
   * `applyZeroBlocks`'s merge, the heal sweeps) still write here; over the
   * next several commits each writer category migrates to its overlay and
   * its imperative entries vanish from this bucket. When the final writer
   * moves off, `#legacyMessages` and the `set messages(...)` shim are
   * deleted and `messages` becomes a pure derivation.
   *
   * Why a shadow instead of an immediate full migration: the writer
   * migration is large (~40 sites across chat.svelte.ts + a couple of
   * components + ~25 test fixtures). Doing it atomically inside one
   * commit would mean tests can't be moved in lockstep with their
   * code — this shadow lets each commit migrate one writer category
   * and keeps the suite green at every boundary.
   */
  #legacyMessages = $state<ChatMessage[]>([]);
  agents = $state<AgentInfo[]>([]);

  /**
   * Live overlay for in-flight assistant / tool / thinking blocks. Keyed
   * by `overlayKey(agent, msg.id)`. Entries are added on SSE `block_start`,
   * mutated in place on `block_delta` (field-level $state reactivity), and
   * removed on `block_canceled` or when the matching canonical row from
   * Zero replicates with terminal status.
   *
   * Subsequent commits migrate the SSE handlers to write here; today the
   * map is read by the `messages` derivation but populated only after
   * commit 5 lands.
   */
  streaming = new SvelteMap<OverlayKey, StreamingEntry>();

  /**
   * Optimistic overlay for user bubbles that haven't yet been confirmed
   * by Zero. Keyed by `overlayKey(agent, msg.id)`. Dropped when the
   * canonical user row arrives via Zero or the send queue acks the
   * `queueBlockId`.
   *
   * Subsequent commits migrate the addUser/confirmPending/etc. path to
   * write here; today the map is read by the `messages` derivation but
   * populated only after commit 6 lands.
   */
  optimistic = new SvelteMap<OverlayKey, OptimisticEntry>();

  /**
   * Derived chat view for the focused agent, merging the legacy bucket
   * (canonical Zero-derived rows + still-imperative SSE/optimistic writes)
   * with the streaming and optimistic overlays. Filters overlay entries
   * by `entry.agent === focused && entry.sessionId === currentSessionId`,
   * so `/clear` (which nulls the agent's sessionId) hides leftover
   * in-flight overlay entries naturally and cross-agent SSE never bleeds
   * into the focused agent's view.
   *
   * Cross-agent leak structural fix: today this is a pass-through over
   * the legacy bucket because overlays are empty. Once SSE handlers
   * (commit 5) and the optimistic path (commit 6) move off the legacy
   * bucket, switching the focused agent re-derives from the new agent's
   * data + only-that-agent's overlay entries — the previous agent's
   * in-flight bubbles disappear because they're scoped to the wrong
   * agent / session, not because anything explicitly clears them.
   *
   * Reactivity contract: per-entry `$state` fields on StreamingEntry /
   * OptimisticEntry fire fine-grained subscriptions on `entry.text +=
   * delta` etc. WITHOUT re-running this derivation. The derivation
   * re-runs only on structural changes (map set/delete, legacy bucket
   * shape change, focusedAgent / agents flip). Hot-path streaming
   * latency stays at one paint frame even on long sessions.
   */
  #derivedMessages = $derived.by<ChatMessage[]>(() => {
    const focused = this._focusedAgent;
    const agentRow = this.agents.find((a) => a.name === focused);
    const sid = agentRow?.sessionId ?? null;

    // Fast-path: while no commit has migrated writers off the legacy
    // bucket, both overlay maps are empty and the public `messages`
    // is literally the legacy array (preserves object identity so
    // existing in-place mutations on bubble fields still surface).
    if (this.streaming.size === 0 && this.optimistic.size === 0) {
      return this.#legacyMessages;
    }

    const overlayIds = new Set<string>();
    const overlayEntries: ChatMessage[] = [];
    for (const entry of this.streaming.values()) {
      if (entry.agent !== focused) continue;
      if (entry.sessionId !== sid) continue;
      overlayEntries.push(entry);
      overlayIds.add(entry.id);
    }
    for (const entry of this.optimistic.values()) {
      if (entry.agent !== focused) continue;
      if (entry.sessionId !== sid) continue;
      overlayEntries.push(entry);
      overlayIds.add(entry.id);
    }
    // Legacy entries lose to overlay shadows on id collision: while a
    // bubble lives in the overlay it's the live, fine-grained-reactive
    // surface; the legacy bucket's stale copy (if any) is suppressed.
    // ChatMessages.svelte's `allMessages` derivation handles pending-
    // pinning, so insertion order — legacy first, then overlay tail —
    // matches the pre-migration "append on push" behavior.
    const out: ChatMessage[] = [];
    for (const m of this.#legacyMessages) {
      if (overlayIds.has(m.id)) continue;
      out.push(m);
    }
    for (const e of overlayEntries) out.push(e);
    return out;
  });

  /**
   * Public read API: the focused agent's chat bubbles. See the comment on
   * `#derivedMessages` for the merge contract; this getter is the access
   * point ChatMessages.svelte / ChatShell.svelte / ChatInput.svelte
   * subscribe to.
   *
   * The `set messages(v)` shim writes to the legacy bucket and exists
   * to keep test fixtures (`chat.messages = [...]`) and the few code
   * paths that still wholesale-replace the array working during the
   * migration. Once the final writer moves to its overlay, the shim
   * (and `#legacyMessages`) can be deleted along with the rest of the
   * tear-out.
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
   * yet have an overlay to write to. Same lifetime as the legacy
   * bucket itself — when the final overlay migration lands, the sys_
   * call sites should either go through a dedicated transient overlay
   * or be removed entirely per the chat-content-is-durable contract.
   */
  pushLocal(msg: ChatMessage): void {
    this.#legacyMessages.push(msg);
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
    this.#legacyMessages.push({
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
      this.#legacyMessages = this.#legacyMessages.filter((_, i) => i !== optIdx);
      return;
    }
    const m = this.#legacyMessages[optIdx];
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
    this.#legacyMessages = this.#legacyMessages.filter(
      (m) => m.queueId !== queueId,
    );
  }

  /** Remove every pending bubble in one go (FIX_FORWARD 2.7 — "Discard all
   *  and continue"). */
  discardAllPending(): void {
    this.#legacyMessages = this.#legacyMessages.filter((m) => !m.pending);
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
    const targetTsWithinRetention = isDateJump
      ? (ts as number) > Date.now() - RETENTION_MS
      : false;
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

    const parsed = parseBlocks(rawBlocks, agent, {
      inflightTurnId: this.inflightTurnIdByAgent[agent] ?? null,
      noResponseGraceUntil: this.noResponseGraceUntil,
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
    this.#legacyMessages = [...settled, ...pending];

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
    for (const m of this.messages) {
      // FRI-95: the user block participates in turn-level terminal-state
      // resolution. It's the always-present render surface for the Stop
      // affordance (Stopping… → Stopped / Stopped — worker had to be
      // force-killed / Already finished), independent of whether an
      // assistant bubble streamed.
      if (m.id === userBlockId) {
        if (status === "aborted") {
          m.status = "aborted";
          if (abortReason) m.abortReason = abortReason;
        } else if (
          status === "complete" &&
          m.status === "stopping"
        ) {
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
        continue;
      }
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
        // FRI-95: thread abort reason through to the assistant bubble too,
        // so a streaming assistant bubble that ended on abort shows the
        // same terminal copy distinction as the user block.
        if (status === "aborted" && abortReason) {
          m.abortReason = abortReason;
        }
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
   * Per-turn grace deadline (epoch ms) after `clearInflightForTurn`.
   * SSE `turn_done` arrives on a separate transport from Zero's WS
   * push of the assistant blocks — there's a brief window where
   * the slot is cleared but the assistant content hasn't replicated
   * to this client yet. parseBlocks's FRI-85 safety net consults
   * this to avoid synthesizing a spurious "Agent didn't respond"
   * bubble in that gap.
   */
  noResponseGraceUntil = $state<Record<string, number>>({});

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
    // terminal-or-quiescent state ('idle', 'stalled', 'error',
    // 'archived', 'archive_requested') means the daemon isn't
    // actively producing output for this agent; bubbles claiming
    // otherwise are stale.
    if (focusedRow.status === "working") return;
    let healed = false;
    for (const m of this.messages) {
      if (m.role === "assistant" && m.status === "streaming") {
        m.status = "complete";
        healed = true;
      } else if (
        (m.role === "tool" || m.role === "thinking") &&
        m.status === "running"
      ) {
        m.status = "done";
        healed = true;
      }
    }
    // Clear the inflight tracker too — agent isn't working, so any
    // value in this slot is a ghost that would mis-render the Send
    // button as Stop on the next render frame.
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
    // Same eager-inflight claim as ChatInput's send handler — see the
    // long comment there. Without it, the Zero mutator's optimistic
    // write fires applyZeroBlocks before flush() resolves and the
    // FRI-85 safety net flashes "Agent didn't respond" for the
    // entire submit-to-first-block gap.
    const agent = this.focusedAgent;
    const eagerTurnId = `t_${item.queueBlockId}`;
    const claimedInflight = this.inflightTurnIdByAgent[agent] == null;
    if (claimedInflight) this.markInflight(agent, eagerTurnId);
    void sendQueue.flush().then((result) => {
      let dispatchedEagerTurn = false;
      for (const s of result.sent) {
        this.confirmPending(s.queueId, s.turnId);
        if (!s.queued) this.markInflight(agent, s.turnId);
        if (s.turnId === eagerTurnId && !s.queued) dispatchedEagerTurn = true;
      }
      for (const qid of result.failed) this.markPendingFailed(qid);
      for (const qid of result.retrying) this.markPendingRetrying(qid);
      // Release the eager claim if the send didn't dispatch immediately.
      if (
        claimedInflight &&
        !dispatchedEagerTurn &&
        this.inflightTurnIdByAgent[agent] === eagerTurnId
      ) {
        this.markInflight(agent, null);
      }
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
    let assistantMarked = false;
    let assistantTerminal = false;
    for (const m of this.messages) {
      if (m.role !== "assistant") continue;
      if (m.id !== turnId && m.turnId !== turnId) continue;
      if (
        m.status === "complete" ||
        m.status === "aborted" ||
        m.status === "error"
      ) {
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
      if (
        m.status === "aborted" ||
        m.status === "error" ||
        m.status === "already_finished"
      ) {
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
    // Guard: only clear/reset state when we're genuinely switching
    // agents OR we have nothing to preserve. Re-entry to the same
    // agent leaves `messages` and the cursors untouched; the binder
    // call below is still safe (it's idempotent), the cached-load
    // path below skips itself (messages already populated), and the
    // post-load probe still runs.
    const switchingAgents = this.focusedAgent !== agent;
    const haveMessages = this.messages.length > 0;
    const isReentry = !switchingAgents && haveMessages;
    if (!isReentry) {
      this.#legacyMessages = [];
      this.oldestBlockId = null;
      this.reachedOldest = false;
      this.historyError = null;
      this.zeroBlocksActive = false;
      // Phase 3.7: reset the per-agent seen-blockIds tracker so a stale
      // entry from the previous agent doesn't trip the delete heuristic
      // here.
      this.zeroSeenBlockIds = new Set();
      // Phase 4.1: focus switch invalidates the markRead memo so the
      // first Zero snapshot for the new agent will fire a fresh cursor
      // write (even if we'd previously marked the same blockId for the
      // PREVIOUS agent, the (device, agent) tuple is different).
      this.lastMarkedBlockIdByAgent.delete(agent);
      // Clear any stale loading-older flag from the previous agent. Without
      // this, if the user scrolled up in agent A and clicked away before
      // the load finished, A's `loadingOlder=true` would persist into B's
      // chat and block B's first pagination request until A's stale finally
      // fires (~350ms later). The new guards in `loadOlderTurns` ensure
      // that stale call won't clobber B's state.
      this.loadingOlder = false;
    }

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
    const cachedRaw = isReentry
      ? []
      : loadJSON<BlockRow[]>(KEYS.transcript(agent), []);
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
    if (cached.length > 0) {
      this.#legacyMessages = [
        ...parseBlocks(cached, agent, {
          inflightTurnId: this.inflightTurnIdByAgent[agent] ?? null,
        }),
        ...queueSynth,
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
    } else if (queueSynth.length > 0) {
      this.#legacyMessages = [...queueSynth];
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
        this.#legacyMessages = [
          ...parseBlocks(blocks, agent, {
            inflightTurnId: this.inflightTurnIdByAgent[agent] ?? null,
            noResponseGraceUntil: this.noResponseGraceUntil,
          }),
          ...queueSynth,
        ];
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
      if (!ar.ok) {
        // FRI-81 PR #22 review B1: probe failed with a non-2xx. We don't
        // have authoritative idle/working, but if a prior turn_started SSE
        // already populated an inflight slot, we can still preserve THAT
        // turn's bubbles and heal the rest. With no recoverable inflight,
        // bail — `classifyOrphanRows` already handled the heuristic
        // cases in parseBlocks and SSE `turn_started` will catch up.
        const cachedInflight = this.inflightTurnIdByAgent[agent] ?? null;
        if (cachedInflight) {
          healOrphanStreamingBubbles(
            this.messages,
            "preserve-active",
            cachedInflight,
          );
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
        healOrphanStreamingBubbles(
          this.messages,
          "preserve-active",
          latestTurnId,
        );
      }
    } catch {
      // FRI-81 PR #22 review B1: probe threw (network/timeout). Same as
      // the !ar.ok branch above — if we already have an inflight slot
      // from a prior SSE turn_started, preserve it and heal the rest.
      // No inflight known → conservative bail.
      const cachedInflight = this.inflightTurnIdByAgent[agent] ?? null;
      if (cachedInflight) {
        healOrphanStreamingBubbles(
          this.messages,
          "preserve-active",
          cachedInflight,
        );
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
   *   - Seed `lastSeqByAgent` from the max `last_event_seq` so SSE replay
   *     dedups partial-content deltas already reflected in canonical rows.
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
    if (resultType === "complete") this.reachedOldest = true;

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
      if (resultType === "complete") this.reachedOldest = true;
      return;
    }

    const blockRows: BlockRow[] = rows.map(zeroBlockRowToBlockRow);
    const parsed = parseBlocks(blockRows, forAgent, {
      inflightTurnId: this.inflightTurnIdByAgent[forAgent] ?? null,
      // FRI-91 Part A: complete the bf34884 grace-map plumbing on this
      // call site — `applyZeroBlocks` runs on every Zero snapshot frame
      // and was the only of the four parseBlocks callers that skipped
      // the grace map. Covers the SSE-cleared-inflight-but-Zero-hasn't-
      // landed-the-block-yet flash, mirroring the REST fetch path.
      noResponseGraceUntil: this.noResponseGraceUntil,
      // FRI-91 Part B: the structural fix. Until Zero confirms the
      // local replica matches upstream for this query, treat any
      // user-only turn as "assistant block hasn't replicated yet,"
      // not "the agent didn't respond." See parseBlocks's safety-net
      // loop for the suppression logic.
      zeroResultIncomplete: resultType !== "complete",
    });
    const parsedById = new Map<string, ChatMessage>();
    for (const m of parsed) parsedById.set(m.id, m);

    // Track which block_ids the current snapshot contains so we can
    // detect deletes: a `blockId` previously delivered by Zero but
    // absent now is a real upstream removal (cancel-queued mutator,
    // daemon `block_canceled`). Without this, deleted rows would
    // linger as ghost bubbles on receivers' devices until they
    // reload. The `zeroSeenBlockIds` tracker grows as new block_ids
    // appear (bounded by distinct blocks ever surfaced for this
    // agent in this session); it resets on focus switch in
    // `loadAgentTurns`.
    const snapshotBlockIds = new Set<string>();
    for (const r of rows) snapshotBlockIds.add(r.block_id);

    // FRI-103: clear sendQueue entries whose pre-minted `queueBlockId`
    // matches a user row in this snapshot. The canonical block landing
    // in the Zero replica is the durable confirmation Seth's data-safety
    // contract requires before removing the localStorage entry. Also
    // collect the queue ids so the bubble-merge below can drop their
    // queue-synth / optimistic-pending bubbles (otherwise both the
    // synth and the canonical bubble end up in the merged list and the
    // user sees a duplicate "#43 merged").
    const ackedQueueIds = new Set<string>();
    for (const r of rows) {
      if (r.role !== "user") continue;
      const entry = sendQueue.items.find((q) => q.queueBlockId === r.block_id);
      if (entry) ackedQueueIds.add(entry.id);
      // Idempotent: no-op if no entry matches. The non-matching
      // common case (every Zero snapshot frame contains user rows
      // that never went through this client's queue) is the hot
      // path; ackByBlockId early-returns without persisting.
      sendQueue.ackByBlockId(r.block_id);
    }

    const merged: ChatMessage[] = [];
    const seen = new Set<string>();
    for (const m of this.messages) {
      const parsedMatch = parsedById.get(m.id);
      if (parsedMatch) {
        merged.push(parsedMatch);
        seen.add(m.id);
        continue;
      }
      // FRI-103: drop synth / optimistic bubbles whose backing queue
      // entry was just acked by the canonical Zero row above. Without
      // this, the queue-synth bubble (id `u_queue_<qid>`) and the
      // canonical user bubble (id `userBlockIdForTurn(turnId)`) both
      // land in `merged` and the user sees two bubbles for the same
      // text. parseBlocks emitted the canonical version in `parsed`
      // already.
      if (m.queueId !== undefined && ackedQueueIds.has(m.queueId)) continue;
      // No parsed counterpart. Decide whether to keep or drop.
      if (
        m.blockId !== undefined &&
        this.zeroSeenBlockIds.has(m.blockId) &&
        !snapshotBlockIds.has(m.blockId)
      ) {
        // The bubble's `blockId` was in a prior Zero snapshot but is
        // missing now — the upstream row was deleted. Drop the
        // bubble so cancel-queued / block_canceled propagate.
        continue;
      }
      // Otherwise preserve. Covers in-flight SSE streams (no
      // blockId yet, or blockId-having streaming row that Zero will
      // deliver as `complete` on the next snapshot), queue-synth
      // (no blockId), optimistic-pending user bubbles, and
      // scroll-back rows older than the 50-row Zero window
      // (blockId-having but not previously seen via Zero — they
      // came from the REST `?before=…` fallback).
      merged.push(m);
    }
    for (const m of parsed) {
      if (!seen.has(m.id)) merged.push(m);
    }
    merged.sort((a, b) => a.ts - b.ts);

    // Update the seen tracker AFTER the merge so this snapshot's
    // block_ids are recognized as "seen via Zero" on the next call.
    for (const bid of snapshotBlockIds) this.zeroSeenBlockIds.add(bid);

    this.#legacyMessages = dropSupersededNoResponseSafetyNet(merged);
    const newOldest = oldestBlockCursor(blockRows);
    if (newOldest !== this.oldestBlockId) {
      // The Zero snapshot shifted the scroll-back cursor. Re-arm
      // pagination: if a prior stale-cursor `loadOlderTurns` set
      // `reachedOldest=true` (cursor pointed at an actually-oldest row,
      // server returned empty), the user would otherwise be stuck —
      // any rows that landed between the stale cursor and the new
      // Zero window would be permanently unreachable via scroll-back.
      this.reachedOldest = false;
    }
    this.oldestBlockId = newOldest;

    let maxSeq = 0;
    for (const r of rows) {
      if (r.last_event_seq > maxSeq) maxSeq = r.last_event_seq;
    }
    if (maxSeq > 0) {
      this.lastSeqByAgent[forAgent] = Math.max(
        this.lastSeqByAgent[forAgent] ?? 0,
        maxSeq,
      );
    }

    // Phase 4.1: advance the per-device read cursor for this agent to
    // the newest block in the snapshot. While the user is focused on
    // this agent's chat, every new block delivery advances the cursor
    // — the semantic is "if you're looking at it, you've seen it."
    // The mutator is idempotent on the (device, agent, block) PK so a
    // re-fire with the same args is a server-side no-op; the
    // `lastMarkedBlockIdByAgent` memo dedups at the client to avoid
    // even sending the redundant push. The first frame after a focus
    // switch always sends a fresh write because `loadAgentTurns`
    // clears the memo for the new agent.
    if (this.markReadFn) {
      // Find the chronologically newest row. Bare `r.id > newest.id`
      // would be a lex-string comparison and Phase 4.11's mixed
      // numeric-string + UUID alphabet makes that meaningless (see
      // `oldestBlockCursor` for the full writeup). Use `(ts, id)`
      // tuple, same as the materialized-view query now orders by.
      let newest: ZeroBlocksRow | null = null;
      for (const r of rows) {
        if (
          !newest ||
          r.ts > newest.ts ||
          (r.ts === newest.ts && r.id > newest.id)
        )
          newest = r;
      }
      if (newest) {
        const prev = this.lastMarkedBlockIdByAgent.get(forAgent);
        if (prev !== newest.block_id) {
          this.lastMarkedBlockIdByAgent.set(forAgent, newest.block_id);
          this.markReadFn(forAgent, newest.block_id);
        }
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
        if (event.agent !== this.focusedAgent) break;
        // FRI-95: thread abort_reason through so the user-block bubble can
        // distinguish "Stopped" (cooperative) from "Stopped — worker had
        // to be force-killed" (forced).
        this.finishTurn(event.turn_id, event.status, event.abort_reason);
        break;
      case "error":
        // Same per-agent quarantine: clear the slot for this turn even
        // when the event is for a non-focused agent.
        if (event.turn_id) this.clearInflightForTurn(event.turn_id);
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

  /** Snapshot of the focused agent's current SDK session id. Stamped onto
   *  StreamingEntry / OptimisticEntry constructions so the `messages`
   *  derivation can filter overlay entries by session — /clear nulls the
   *  agent's sessionId and stale in-flight entries become invisible
   *  without imperative cleanup.
   *
   *  Returns `null` when the agents row hasn't replicated yet (Zero race
   *  on cold reload). An entry stamped with `null` is invisible until the
   *  agents row materializes with a matching null; in practice the
   *  block_start that produces such an entry runs only after agents has
   *  replicated (the SSE handler runs in the same focused-agent context
   *  the user is actively viewing), so this is a defensive default. */
  private currentSessionFor(agent: string): string | null {
    return this.agents.find((a) => a.name === agent)?.sessionId ?? null;
  }

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
    const agent = this.focusedAgent;
    const sid = this.currentSessionFor(agent);
    if (event.kind === "text") {
      const role = event.role === "user" ? "user" : "assistant";
      // FIX_FORWARD 2.6: user blocks key by turn_id so the local pending
      // bubble (re-keyed on POST-success) and the canonical block from the
      // daemon converge on the same row.
      const id =
        role === "user" ? userBlockIdForTurn(event.turn_id) : `b_${event.block_id}`;
      if (this.messages.some((m) => m.id === id)) return;
      if (role === "user") {
        // User-block path stays on the legacy bucket until commit 6 lights
        // up the optimistic overlay. handleBlockStart for users is the
        // mail / scratch / scheduled path (user_chat blocks come in via
        // addUser → confirmPending and skip this handler thanks to the
        // dedup above).
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

  /** Find the overlay tool entry matching a SSE block_id. tool overlay
   *  entries are keyed by `t_<toolId>` rather than `b_<blockId>` — we
   *  need a scan-by-blockId for `input_json_delta` routing. Cost is
   *  bounded by streaming.size (typically 1-3 entries during a turn). */
  private findStreamingByBlockId(
    agent: string,
    blockId: string,
  ): StreamingEntry | undefined {
    for (const entry of this.streaming.values()) {
      if (entry.agent !== agent) continue;
      if (entry.blockId === blockId) return entry;
    }
    return undefined;
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
    // directly to legacy without going through SSE). Preserved so
    // mid-PR test fixtures and edge cases keep working until the rest
    // of the migration lands.
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
    kind: "text" | "thinking" | "tool_use" | "tool_result" | "error";
    content_json: string;
    status: "complete" | "aborted" | "error" | "queued";
    turn_id: string;
    role: string;
    source: string | null;
    ts: number;
  }): void {
    const agent = this.focusedAgent;
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
      this.#legacyMessages.push({
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
      if (isNoResponseSentinel(event.role, parsed.text)) {
        // FRI-85 supersedes FRI-81 D5: the sentinel's terminal state used to
        // be handled by dropping the placeholder block_start pushed (D5's
        // convergence with parseBlocks). FRI-85 changed the contract — the
        // reload path now synthesizes a "no-response" affordance instead of
        // continuing past the row, so live must do the same. Removing the
        // streaming bubble at `b_<id>` still satisfies D5's cleanup intent;
        // the new affordance bubble at `nr_<turnId>` is the converged shape.
        const streamingId = `b_${event.block_id}`;
        this.streaming.delete(overlayKey(agent, streamingId));
        const idx = this.#legacyMessages.findIndex((m) => m.id === streamingId);
        if (idx !== -1) this.#legacyMessages.splice(idx, 1);
        const nrId = noResponseIdForTurn(event.turn_id);
        if (!this.messages.some((m) => m.id === nrId)) {
          this.#legacyMessages.push({
            id: nrId,
            role: "assistant",
            kind: "no-response",
            noResponseSentinel: true,
            text: "",
            status: "complete",
            agent,
            turnId: event.turn_id,
            ts: event.ts,
          });
        }
        return;
      }
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
      // Streaming overlay update first. The overlay holds the live bubble
      // during the streaming phase; finalizing in place keeps the user's
      // view stable until Zero replicates the canonical row (which is
      // pruned by a later convergence sweep — see commit 9).
      const overlayEntry =
        event.role === "user"
          ? undefined
          : this.streaming.get(overlayKey(agent, id));
      if (overlayEntry && overlayEntry.role === "assistant") {
        if (typeof parsed.text === "string") overlayEntry.text = parsed.text;
        overlayEntry.status = mappedStatus;
        return;
      }
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
      // — was never emitted in the first place). Land canonical in the
      // legacy bucket so Zero's eventual replicate dedupes on id.
      const role = event.role === "user" ? "user" : "assistant";
      this.#legacyMessages.push({
        id,
        role,
        text: parsed.text ?? "",
        status: mappedStatus,
        agent,
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
      // FRI-81 D4: converge with parseBlocks's ghost-filter. An empty
      // thinking block that completes (rather than being cancelled via
      // block_canceled IPC) is a ghost; drop the placeholder that
      // block_start created. Aborted/error preserve their bubble so the
      // user sees a "stopped" affordance.
      const hasText =
        typeof parsed.text === "string" && parsed.text.length > 0;
      if (!hasText && event.status === "complete") {
        this.streaming.delete(overlayKey(agent, id));
        this.#legacyMessages = this.#legacyMessages.filter((m) => m.id !== id);
        return;
      }
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
      const overlayEntry = this.streaming.get(overlayKey(agent, id));
      if (overlayEntry && overlayEntry.role === "thinking") {
        if (typeof parsed.text === "string") overlayEntry.text = parsed.text;
        overlayEntry.status = status;
        return;
      }
      for (const m of this.messages) {
        if (m.id !== id) continue;
        if (typeof parsed.text === "string") m.text = parsed.text;
        m.status = status;
        return;
      }
      this.#legacyMessages.push({
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
      const overlayEntry = this.streaming.get(overlayKey(agent, id));
      if (overlayEntry && overlayEntry.role === "tool") {
        overlayEntry.input = parsed.input;
        // FRI-84: canonical input is now in `entry.input`; drop the
        // streaming accumulator so the renderer switches to the
        // pretty-printed final form.
        overlayEntry.inputPartialJson = undefined;
        if (parsed.name && !overlayEntry.toolName) overlayEntry.toolName = parsed.name;
        // A tool_use that completes with aborted/error never gets a
        // tool_result follow-up to flip the bubble off "running" — honor
        // the terminal status here.
        if (event.status === "aborted") overlayEntry.status = "aborted";
        else if (event.status === "error") overlayEntry.status = "error";
        return;
      }
      for (const m of this.messages) {
        if (m.id !== id) continue;
        m.input = parsed.input;
        m.inputPartialJson = undefined;
        if (parsed.name && !m.toolName) m.toolName = parsed.name;
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
      this.#legacyMessages.push({
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
      const overlayEntry = this.streaming.get(overlayKey(agent, id));
      if (overlayEntry && overlayEntry.role === "tool") {
        overlayEntry.status = parsed.is_error ? "error" : "done";
        if (typeof parsed.text === "string") overlayEntry.output = parsed.text;
        return;
      }
      for (const m of this.messages) {
        if (m.id !== id) continue;
        m.status = parsed.is_error ? "error" : "done";
        if (typeof parsed.text === "string") m.output = parsed.text;
        return;
      }
      // No preceding tool_use bubble — likely a ring eviction OR the
      // first 50-row Zero window cut mid-turn. A "(unknown)" tool card
      // with just the result text ("mail 154 closed", a bare exit code,
      // …) is more noise than signal; the user already lost the tool
      // call's input, name, and motivation. Drop the orphan; if its
      // tool_use later arrives via scroll-back, parseBlocks's
      // tool_result branch will produce a paired bubble at that point.
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
    // Drop matching streaming overlay entries — the overlay key is
    // (agent, id) and id can be `b_<bid>` / `th_<bid>` / `t_<toolId>`,
    // so scan-by-blockId is the only correct match for the tool case.
    for (const [key, entry] of this.streaming.entries()) {
      if (entry.blockId === event.block_id) this.streaming.delete(key);
    }
    this.#legacyMessages = this.#legacyMessages.filter(
      (m) => m.blockId !== event.block_id,
    );
  }

  // Phase 5: `handleBlockMetaUpdate` removed — Zero replicates the
  // queued → complete UPDATEs (and aborted DELETEs) on the blocks
  // table; `applyZeroBlocks` re-derives the message list via
  // `parseBlocks` which re-sorts by ts.

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
      this.#legacyMessages = this.#legacyMessages.filter(
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
  /** Phase 4.11: text UUID (was bigserial number). Equal to
   *  blockId for mutator-INSERTed rows; for legacy daemon-written
   *  rows the column still holds the original bigserial value as
   *  text (e.g. "123"). */
  id: string;
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

/** Phase 3.7: snake_case Zero row shape mirrors the Postgres `blocks`
 *  table — exposed here (not imported from `zero.svelte.ts`) to avoid
 *  the chat → zero circular dependency. Aligned with `ZeroBlockRow`
 *  in `stores/zero.svelte.ts`. */
export interface ZeroBlocksRow {
  /** Phase 4.11: flipped from `number` → `string` alongside the
   *  Drizzle bigserial→text(uuid) migration. */
  id: string;
  block_id: string;
  turn_id: string;
  agent_name: string;
  session_id: string;
  message_id: string | null;
  block_index: number;
  role: string;
  kind: string;
  source: string | null;
  content_json: unknown;
  status: string;
  streaming: boolean;
  origin_mutation_id: string | null;
  ts: number;
  last_event_seq: number;
}

/** Convert a Zero row (snake_case, jsonb columns auto-parsed) to the
 *  `BlockRow` shape `parseBlocks` consumes (camelCase, `content_json`
 *  re-serialized to a JSON string). The string round-trip is load-
 *  bearing: parseBlocks runs `parseBlockContent` which calls JSON.parse
 *  on `contentJson` — passing a parsed object would double-parse and
 *  throw. */
export function zeroBlockRowToBlockRow(r: ZeroBlocksRow): BlockRow {
  return {
    id: r.id,
    blockId: r.block_id,
    turnId: r.turn_id,
    agentName: r.agent_name,
    sessionId: r.session_id,
    messageId: r.message_id,
    blockIndex: r.block_index,
    role: r.role,
    kind: r.kind,
    source: r.source,
    contentJson:
      typeof r.content_json === "string"
        ? r.content_json
        : JSON.stringify(r.content_json ?? null),
    status: r.status,
    ts: r.ts,
    lastEventSeq: r.last_event_seq,
  };
}

/** Strip safety-net "Agent didn't respond" bubbles that are no longer
 *  load-bearing. Two cases:
 *
 *   1. **Superseded**: the turn has since produced real assistant
 *      content. parseBlocks emits `nr_<turnId>` with
 *      `noResponseSentinel=false` for any user_chat turn that lacks
 *      assistant blocks at parse time — a fundamentally stateful
 *      inference that's wrong during the brief race where the user
 *      message lands in Zero before the first assistant block does.
 *   2. **Orphaned**: the user_chat user bubble that anchored the
 *      affordance is gone. Happens when the upstream blocks row was
 *      deleted (cancel-queued mutator, daemon block_canceled) but the
 *      nr_ synth from a prior parse run is still in `messages`.
 *
 *  Sentinel-driven nr_ bubbles (`noResponseSentinel=true`) come from
 *  the SDK's trained marker block and are authoritative; we never
 *  drop those. */
export function dropSupersededNoResponseSafetyNet(
  messages: ChatMessage[],
): ChatMessage[] {
  const respondedTurns = new Set<string>();
  const userChatTurns = new Set<string>();
  for (const m of messages) {
    if (!m.turnId) continue;
    if (m.role === "assistant" && m.kind !== "no-response") {
      respondedTurns.add(m.turnId);
    } else if (m.role === "thinking" || m.role === "tool") {
      respondedTurns.add(m.turnId);
    } else if (m.role === "user" && (m.source ?? "user_chat") === "user_chat") {
      userChatTurns.add(m.turnId);
    }
  }
  return messages.filter((m) => {
    if (
      m.role === "assistant" &&
      m.kind === "no-response" &&
      m.noResponseSentinel === false &&
      m.turnId
    ) {
      if (respondedTurns.has(m.turnId)) return false;
      if (!userChatTurns.has(m.turnId)) return false;
    }
    return true;
  });
}

/**
 * Convert BlockRow[] (from /api/agents/:name/blocks) into the ChatMessage[]
 * the chat UI renders. Mirrors `handleBlockComplete`'s id scheme so a
 * canonical block row + a live block_complete SSE event converge on the
 * same bubble id (FIX_FORWARD 3.7 + 2.6).
 */
/**
 * FRI-81 D2/D3: a thinking or tool_use row left at status='streaming' in
 * the DB is an orphan when the worker died or the daemon restarted before
 * any teardown could finalize it. Heuristic to decide which streaming rows
 * are orphans without an authoritative "is this turn active" signal:
 *
 *   - Compute the max ts across all rows ("global high-water"). The active
 *     turn, if one exists, is by definition the turn that produced the
 *     newest block.
 *   - For each turn, compute the turn's max ts.
 *   - A streaming row is an orphan if EITHER:
 *       (a) Its turn's max ts is strictly less than the global high-water —
 *           i.e. a later turn has produced blocks since, so this turn
 *           cannot still be live.
 *       (b) Its own ts is strictly less than its turn's max ts — i.e. a
 *           sibling block in the same turn landed later (possibly already
 *           terminal), so the worker moved past this block.
 *
 * The streaming-mid-current-turn case (this block IS the latest activity
 * we know about) is preserved so reload-during-stream resumes cleanly —
 * `handleBlockDelta` gates on `m.status === "streaming"` / "running" and
 * would otherwise reject the next SSE delta.
 *
 * `loadAgentTurns`'s post-render `/api/agents/:name` probe handles the
 * remaining case (this is the only/latest turn AND the agent is idle)
 * via `healOrphanStreamingBubbles` on the live message array.
 *
 * Known race (PR #22 review N1): rule (b) compares `ts` values. The
 * daemon's `block_complete` write bumps the row's `ts` to `Date.now()`
 * via `writeAndPublish`'s atomic helper; if a sibling block in the same
 * turn has already completed AND its ts is later than this still-
 * streaming block's `ts`, this block is classified as orphan even
 * though it might still be receiving deltas. The window is bounded —
 * the next SSE `block_complete` event flips the bubble to a real
 * terminal status and overrides the misclassification — but the user
 * sees a brief "Stopped" affordance on a block that wasn't stopped.
 * Acceptable for now; a full fix would require tracking the daemon's
 * live-turn map on the dashboard side, which is more state than the
 * symptom warrants.
 */
function classifyOrphanRows(blocks: BlockRow[]): Set<string> {
  const orphans = new Set<string>();
  if (blocks.length === 0) return orphans;
  const maxTsByTurn = new Map<string, number>();
  let globalMax = -Infinity;
  for (const b of blocks) {
    const prev = maxTsByTurn.get(b.turnId);
    if (prev === undefined || b.ts > prev) maxTsByTurn.set(b.turnId, b.ts);
    if (b.ts > globalMax) globalMax = b.ts;
  }
  for (const b of blocks) {
    if (b.status !== "streaming") continue;
    const turnMax = maxTsByTurn.get(b.turnId) ?? b.ts;
    if (turnMax < globalMax || b.ts < turnMax) orphans.add(b.blockId);
  }
  return orphans;
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
    } else if (
      (m.role === "thinking" || m.role === "tool") &&
      m.status === "running"
    ) {
      if (mode === "preserve-active" && m.turnId === activeTurnId) continue;
      m.status = "aborted";
    }
  }
}

/**
 * Per-turn slice of parseBlocks. Walks ONE turn's blocks and produces the
 * messages they translate to, plus a small metadata bag the cross-turn
 * safety-net loop needs.
 *
 * The split lets a later commit memoize per-turn output: a turn's parsed
 * shape is a pure function of (its block rows, the orphan set). Turns
 * without streaming-status blocks are deterministic w.r.t. the cross-turn
 * orphan-classification too (orphans only flag streaming blocks). So a
 * cache keyed by (agent, turnId, signature) hits whenever a turn's
 * `last_event_seq` sum is unchanged, which is the common case during
 * streaming on a long session (380/381 turns unchanged per frame).
 */
interface ParsedTurn {
  parsed: ChatMessage[];
  /** Set when this turn carries a `source='user_chat'` user block — drives
   *  the cross-turn safety-net's "agent didn't respond" synthesis. */
  userInfo: { ts: number } | null;
  /** True if the turn produced any assistant-side content (text, thinking,
   *  tool_use, error) OR an SDK no-response sentinel. The safety net only
   *  synthesizes for turns where this is false. */
  hasAssistantContent: boolean;
}

/**
 * Per-turn parse cache. Module-scoped because there is exactly one chat
 * store in the app and the cache key already namespaces by agent. Tests
 * call `__resetParseCache()` between cases to keep fixtures isolated.
 *
 * The cache hits whenever a turn's `last_event_seq` sum is unchanged
 * since the last parse, which is the common case during streaming on a
 * long session: 380 of 381 turns are inert between SSE delta frames and
 * skip re-parsing.
 *
 * A cache hit returns a top-level spread copy of the cached parsed
 * array (`map(m => ({ ...m }))`). Downstream code mutates message fields
 * in place during SSE streaming (`m.text += delta`, `m.status =
 * 'complete'`, etc.), and a shared reference would let those mutations
 * pollute the cache. Spread copy is cheap (~10µs per turn for typical
 * 3-5-message turns) and sufficient because no caller mutates deep
 * fields — top-level assignments are the entire mutation surface.
 *
 * Cache-eligibility gate: turns containing any streaming-status block
 * are NEVER cached. classifyOrphanRows reads the global max ts across
 * all blocks to decide orphan-classification, so a streaming block in
 * turn X is sensitive to NEW blocks arriving in turn Y. By only caching
 * turns whose blocks are all terminal (complete / aborted / error /
 * queued), we avoid the cross-turn signature dependency that would
 * otherwise force whole-cache invalidation on every new block.
 */
interface CachedTurnParse {
  signature: number;
  parsed: ChatMessage[];
  userInfo: { ts: number } | null;
  hasAssistantContent: boolean;
}
const _parseCache = new Map<string, CachedTurnParse>();

/** Test-only hook to clear the per-turn parse cache between cases. */
export function __resetParseCache(): void {
  _parseCache.clear();
}

/** Sum of `last_event_seq` across a turn's blocks. Monotonic per-block,
 *  so any block addition / update bumps the sum and forces a cache miss.
 *  Block deletion (cancel-queued path) shrinks the sum, also a miss. */
function turnParseSignature(blocks: readonly BlockRow[]): number {
  let s = 0;
  for (const b of blocks) s += b.lastEventSeq ?? 0;
  return s;
}

/** True iff none of the turn's blocks are at status='streaming'. Streaming
 *  blocks make the per-turn parse depend on the cross-turn orphan
 *  classification (which reads global max ts); only terminal-block turns
 *  are safely memoizable. */
function turnIsCacheable(blocks: readonly BlockRow[]): boolean {
  for (const b of blocks) if (b.status === "streaming") return false;
  return true;
}

function parseTurnBlocks(
  turnBlocks: readonly BlockRow[],
  agent: string,
  orphans: Set<string>,
): ParsedTurn {
  const out: ChatMessage[] = [];
  const toolByToolId = new Map<string, ChatMessage>();
  // Pre-scan: which tool_use_ids actually have a tool_use row in this
  // turn. The 50-row Zero window — and the `?before=` scroll-back
  // batches that share the same shape — often slice between a tool_use
  // and its tool_result; we want to drop the orphan tool_result rather
  // than render a `toolName="(unknown)"` card with just the result text
  // ("mail 154 closed", a bare exit code, …) which is noise without the
  // tool name + input. FRI-81 D1 still has to work: when both rows ARE
  // in the turn but `finalizeStreamingBlocks` bumped the tool_use past
  // the tool_result's ts, the sort processes tool_result first and the
  // fold-in-existing path needs to materialize a placeholder. So:
  // window-cut orphan ⇒ drop, ts-reorder orphan ⇒ synth-then-fold.
  const toolUseIdsInBatch = new Set<string>();
  for (const b of turnBlocks) {
    if (b.kind === "tool_use") {
      const p = parseBlockContent(b.contentJson);
      const tid = p.tool_use_id ?? b.blockId;
      toolUseIdsInBatch.add(tid);
    }
  }
  let userInfo: { ts: number } | null = null;
  let hasAssistantContent = false;
  let sentinelSeen = false;
  // Sort within the turn. `ts` is primary so jsonl-recovery rows (fresh id
  // but old ts) interleave correctly with their live siblings; `id` is the
  // ms-collision tiebreaker (text UUID, lexical compare — arbitrary-but-
  // stable, matching bigserial semantics pre-Phase 4.11).
  const sorted = [...turnBlocks].sort(
    (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const b of sorted) {
    const parsed = parseBlockContent(b.contentJson);
    if (b.kind === "text") {
      const role = b.role === "user" ? "user" : "assistant";
      if (isNoResponseSentinel(b.role, parsed.text)) {
        // FRI-85: the SDK's trained end-of-turn marker. Instead of FRI-9's
        // silent suppression (which left the user staring at their own
        // message), render a faint "Agent acknowledged — no reply needed"
        // affordance. Single bubble per turn; idempotent on duplicate
        // sentinels (a refork can produce two).
        if (b.turnId && !sentinelSeen) {
          sentinelSeen = true;
          hasAssistantContent = true;
          out.push({
            id: noResponseIdForTurn(b.turnId),
            role: "assistant",
            kind: "no-response",
            noResponseSentinel: true,
            text: "",
            status: "complete",
            agent,
            turnId: b.turnId,
            ts: b.ts,
          });
        }
        continue;
      }
      if (role === "assistant") hasAssistantContent = true;
      if (role === "user" && b.turnId) {
        // user_chat is the only source that carries the "I sent something
        // and expected a reply" semantics — mail / queue_inject / scratch
        // / agent_spawn / schedule are agent-driven traffic where a silent
        // turn is fine. The safety-net synth below only fires for
        // user_chat-sourced user blocks.
        if (b.source === "user_chat") {
          userInfo = { ts: b.ts };
        }
      }
      const id =
        role === "user" ? userBlockIdForTurn(b.turnId) : `b_${b.blockId}`;
      // Preserve the row's `streaming` state. On reload during a turn,
      // the assistant block is still being filled — collapsing it to
      // `complete` here would make `handleBlockDelta` reject every
      // subsequent SSE delta (it gates on `m.status === "streaming"`)
      // and the user would see a frozen replay instead of a live
      // resumption. User blocks are always finalized at insert time
      // so they map cleanly to `complete`.
      const isOrphan = orphans.has(b.blockId);
      const status: ChatMessage["status"] =
        role === "user"
          ? b.status === "queued"
            ? "queued"
            : "complete"
          : b.status === "streaming"
            ? isOrphan
              ? "aborted"
              : "streaming"
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
      // FRI-81 D4: an empty thinking row at status='complete' is a ghost
      // — typically an SDK-opened block the worker abandoned before the
      // FRI-78 block-cancel IPC existed. The dashboard's ThinkingBlock
      // renders empty text as "redacted by Anthropic", which is not what
      // these rows are. Drop them on reload. Aborted / error empties are
      // preserved because they carry the user-visible "stopped" affordance
      // (the worker explicitly tore the block down). Streaming rows are
      // preserved so reload-mid-turn deltas still attach.
      const hasText =
        typeof parsed.text === "string" && parsed.text.length > 0;
      if (!hasText && b.status === "complete") continue;
      // FRI-85: only count rows that survive the D4 filter as assistant
      // content. A dropped ghost thinking row should not suppress the
      // user-only-turn safety-net no-response affordance below.
      if (b.turnId) hasAssistantContent = true;
      // Same shape for thinking blocks. `handleBlockDelta` gates on
      // `m.status === "running"` for thinking; preserve "running"
      // for streaming rows so reload-mid-turn deltas append.
      const isOrphan = orphans.has(b.blockId);
      const status: ChatMessage["status"] =
        b.status === "streaming"
          ? isOrphan
            ? "aborted"
            : "running"
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
      if (b.turnId) hasAssistantContent = true;
      const toolId = parsed.tool_use_id ?? b.blockId;
      const isOrphan = orphans.has(b.blockId);
      const status: ChatMessage["status"] =
        b.status === "aborted"
          ? "aborted"
          : b.status === "error"
            ? "error"
            : b.status === "streaming" && isOrphan
              ? "aborted"
              : "running";
      // FRI-81 D1: a tool_result row may have been sorted (and processed)
      // before its tool_use sibling when `finalizeStreamingBlocks` updates
      // the tool_use's `ts` past the tool_result's original insert `ts`.
      // The earlier code path skipped the tool_use entirely, leaving the
      // tool-card with toolName="(unknown)" and no input. Instead, fold
      // the tool_use's authoritative name/input into the existing synth.
      const existing = toolByToolId.get(toolId);
      if (existing) {
        if (parsed.name) existing.toolName = parsed.name;
        if (parsed.input !== undefined) existing.input = parsed.input;
        if (!existing.turnId) existing.turnId = b.turnId;
        // Don't downgrade a terminal tool_result status with a tool_use
        // "running" — but DO honor a tool_use-side aborted/error since
        // those won't have a tool_result follow-up.
        if (status === "aborted" || status === "error") existing.status = status;
        continue;
      }
      const msg: ChatMessage = {
        id: `t_${toolId}`,
        role: "tool",
        text: "",
        status,
        toolId,
        toolName: parsed.name ?? "",
        input: parsed.input,
        // FRI-84: blockId on reload mirrors the live handleBlockStart
        // setter so any reload-mid-stream delta routing finds this row.
        blockId: b.blockId,
        turnId: b.turnId,
        ts: b.ts,
      };
      out.push(msg);
      toolByToolId.set(toolId, msg);
    } else if (b.kind === "error") {
      if (b.turnId) hasAssistantContent = true;
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
      if (b.turnId) hasAssistantContent = true;
      const toolId = parsed.tool_use_id ?? "";
      const status = parsed.is_error ? "error" : "done";
      const existing = toolByToolId.get(toolId);
      if (existing) {
        existing.status = status;
        existing.output = parsed.text ?? "";
      } else if (toolUseIdsInBatch.has(toolId)) {
        // FRI-81 D1: the tool_use IS in this batch but hasn't been
        // processed yet because `finalizeStreamingBlocks` bumped its
        // ts past the tool_result's. Materialize a placeholder so the
        // upcoming tool_use can fold its name + input in.
        const synth: ChatMessage = {
          id: `t_${toolId}`,
          role: "tool",
          text: "",
          status,
          toolId,
          toolName: "(unknown)",
          output: parsed.text ?? "",
          turnId: b.turnId,
          ts: b.ts,
        };
        out.push(synth);
        toolByToolId.set(toolId, synth);
      }
      // Else: window-cut orphan — drop. See `toolUseIdsInBatch`
      // pre-scan comment at the top of parseTurnBlocks.
    }
  }
  return { parsed: out, userInfo, hasAssistantContent };
}

export function parseBlocks(
  blocks: BlockRow[],
  agent: string,
  opts: {
    inflightTurnId?: string | null;
    /** Per-turn grace deadline (epoch ms) for the FRI-85 safety net.
     *  Owned by ChatState.noResponseGraceUntil; covers the SSE-faster-
     *  than-Zero race where the inflight slot has cleared but the
     *  assistant block hasn't replicated to this client yet. */
    noResponseGraceUntil?: Record<string, number>;
    /** FRI-91: the input came from a Zero snapshot whose `resultType` is
     *  not yet `"complete"` (initial bootstrap still streaming in, or the
     *  local IndexedDB replica is behind upstream). The safety-net loop
     *  must NOT synthesize "Agent didn't respond" for user-only turns
     *  while this is true — the missing assistant blocks may simply not
     *  have replicated yet. Only call sites that hand parseBlocks a
     *  partial view (applyZeroBlocks) set this; REST-driven paths pass
     *  full server payloads and leave it falsy. */
    zeroResultIncomplete?: boolean;
  } = {},
): ChatMessage[] {
  // Cross-turn input: which streaming blocks are orphans (their turn is no
  // longer the live one, or a sibling in the same turn already moved past
  // them). Computed once for the whole input; per-turn parsing reads from
  // the resulting Set.
  const orphans = classifyOrphanRows(blocks);

  // Group by turnId, preserving the global chronological order of turns
  // (by each turn's earliest ts). Within-turn ordering happens inside
  // parseTurnBlocks via its own (ts, id) sort.
  const byTurn = new Map<string, BlockRow[]>();
  const turnEarliestTs = new Map<string, number>();
  for (const b of blocks) {
    const arr = byTurn.get(b.turnId);
    if (arr) arr.push(b);
    else byTurn.set(b.turnId, [b]);
    const prev = turnEarliestTs.get(b.turnId);
    if (prev === undefined || b.ts < prev) turnEarliestTs.set(b.turnId, b.ts);
  }
  const turnOrder = [...byTurn.keys()].sort((a, b) => {
    const at = turnEarliestTs.get(a)!;
    const bt = turnEarliestTs.get(b)!;
    return at - bt || (a < b ? -1 : a > b ? 1 : 0);
  });

  // Per-turn parse with memoization. Cache hits return a top-level spread
  // copy of the cached parsed array — downstream mutates message fields
  // (m.text += delta, m.status = …) in place during SSE streaming, and
  // sharing references would let those mutations pollute the cache.
  const out: ChatMessage[] = [];
  const userTurns = new Map<string, { ts: number }>();
  const assistantTurns = new Set<string>();
  for (const tid of turnOrder) {
    const turnBlocks = byTurn.get(tid)!;
    const cacheable = turnIsCacheable(turnBlocks);
    const signature = cacheable ? turnParseSignature(turnBlocks) : -1;
    const cacheKey = `${agent}|${tid}`;
    let turn: ParsedTurn;
    if (cacheable) {
      const cached = _parseCache.get(cacheKey);
      if (cached && cached.signature === signature) {
        // Hit: spread-copy each cached message to insulate the cache from
        // downstream field mutations (text/status/input/output).
        turn = {
          parsed: cached.parsed.map((m) => ({ ...m })),
          userInfo: cached.userInfo,
          hasAssistantContent: cached.hasAssistantContent,
        };
      } else {
        turn = parseTurnBlocks(turnBlocks, agent, orphans);
        _parseCache.set(cacheKey, {
          signature,
          // Store the fresh parse-output as the cache snapshot. Subsequent
          // hits spread-copy from this stored array; the stored array is
          // never mutated by downstream code because it's never returned
          // verbatim.
          parsed: turn.parsed.map((m) => ({ ...m })),
          userInfo: turn.userInfo,
          hasAssistantContent: turn.hasAssistantContent,
        });
      }
    } else {
      turn = parseTurnBlocks(turnBlocks, agent, orphans);
      // Evict any stale entry — the turn was previously terminal-and-
      // cached, then a fresh streaming block arrived (e.g., a refork that
      // re-opens the turn). Clearing keeps the cache honest.
      _parseCache.delete(cacheKey);
    }
    if (turn.userInfo) userTurns.set(tid, turn.userInfo);
    if (turn.hasAssistantContent) assistantTurns.add(tid);
    out.push(...turn.parsed);
  }

  // FRI-85 safety net: for any user_chat-sourced user message whose turn
  // produced zero assistant-side blocks (text/thinking/tool/error), synth
  // an "Agent didn't respond" affordance so the user is never left staring
  // at an unanswered message. Covers H3 (worker died before block_start),
  // H5 (entire response was Task sub-agent traffic filtered at the worker),
  // and any other "turn completed silently" path that doesn't already
  // leave a visible artifact. Inserted just after the user block by ts so
  // the natural chronological sort keeps it adjacent.
  // Suppress the synth for the agent's currently in-flight turn.
  // The Claude SDK's first stream_event can land anywhere from
  // hundreds of ms to many seconds after submit (model latency,
  // queue depth, tool-call subprocess startup). A blanket time
  // grace would either flash the "Agent didn't respond" affordance
  // for slow turns or hide it for genuinely-failed-fast turns; the
  // chat store's `inflightTurnIdByAgent` is the unambiguous signal.
  // While a turn is the agent's in-flight turn, the safety-net
  // never fires; once it stops being in-flight (turn_done from
  // SSE or agents.status flip to idle), the next parseBlocks run
  // will see no inflight match and the synth can fire if the turn
  // genuinely produced no assistant content.
  const inflight = opts.inflightTurnId;
  const grace = opts.noResponseGraceUntil;
  const now = Date.now();
  for (const [turnId, info] of userTurns) {
    if (assistantTurns.has(turnId)) continue;
    if (inflight && turnId === inflight) continue;
    // Post-clear grace: SSE turn_done cleared the inflight slot, but
    // Zero may still be pushing the assistant block over WS. Without
    // this check, the next parseBlocks pass on a frame between SSE
    // turn_done and Zero block-landing flashes a spurious
    // "Agent didn't respond" bubble that vanishes ~1 frame later.
    const graceDeadline = grace?.[turnId];
    if (graceDeadline && graceDeadline > now) continue;
    // FRI-91: while Zero hasn't confirmed the local replica matches
    // upstream, a missing assistant block is indistinguishable from
    // "the worker died" vs. "the row just hasn't replicated yet."
    // The in-memory grace map can't cover this on page reload (it's
    // wiped on every load); the resultType signal is the only thing
    // that survives. Skip synthesis until Zero says "complete."
    if (opts.zeroResultIncomplete) continue;
    out.push({
      id: noResponseIdForTurn(turnId),
      role: "assistant",
      kind: "no-response",
      noResponseSentinel: false,
      text: "",
      status: "complete",
      agent,
      turnId,
      // +1ms keeps it strictly after its user message even when ts
      // collisions occur (a fast turn can land sub-millisecond).
      ts: info.ts + 1,
    });
  }
  // Final ts-sort. The per-turn parse emits each turn's messages in (ts,
  // id) order, but concatenating turns by their earliest ts can leave two
  // overlapping turns ordered as [all of X, all of Y] when the old single-
  // pass parse would have interleaved them by ts (canonical case: a
  // mail-source user bubble landing between sibling blocks of a user_chat
  // turn). Sort once across the combined list to restore that
  // chronological interleaving — and to slot any safety-net synth
  // adjacent to its anchoring user bubble.
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Lowest block_id across an array. Used as the next `before` cursor for
 *  scroll-up pagination (FIX_FORWARD 3.7). */
export function oldestBlockCursor(blocks: BlockRow[]): string | null {
  // Compare by `(ts, id)` tuple, NOT by bare `id`. Phase 4.11 made
  // `blocks.id` a text UUID; the pre-migration rows that came in via
  // legacy_sqlite restore kept their old bigserial ids as strings
  // ("9943", "9942", …). A bare lexical `b.id < oldest.id` is meaningless
  // across that mixed alphabet — e.g. `"2241..." < "9943" < "ebec..."` —
  // and chooses an "oldest" that has nothing to do with chronology, then
  // hands that anchor to the daemon's `?before=` pagination which
  // dutifully fetches rows older than the wrong row.
  let oldest: BlockRow | null = null;
  for (const b of blocks) {
    if (
      oldest === null ||
      b.ts < oldest.ts ||
      (b.ts === oldest.ts && b.id < oldest.id)
    )
      oldest = b;
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

