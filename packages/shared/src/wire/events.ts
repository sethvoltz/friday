/**
 * Wire schema for the SSE channel between daemon → SvelteKit → browser.
 *
 * Single SSE stream at GET /api/events. Per-turn POST returns a turn_id
 * immediately; the streaming events flow on this channel tagged with that id.
 *
 * All events carry `v: 1` for forward-compat. Server-assigned `seq` is used
 * for replay via `Last-Event-ID`.
 *
 * FIX_FORWARD 1.5 collapsed token-level streaming events (`text_delta`,
 * `thinking_*`, `tool_use_*`, `compaction_*`) into the block-level lifecycle
 * (`block_start`, `block_delta`, `block_complete`). The
 * `connection_established` event is sent first on every new SSE connection
 * to carry the daemon's `boot_id` (FIX_FORWARD 1.6) — clients reset their
 * per-agent cursors on `boot_id` mismatch.
 */

// Phase 5: AgentType/AgentStatus imports removed — the
// AgentLifecycleEvent/AgentStatusEvent shapes that referenced them
// are retired.

export type WireEvent =
  | TurnStartedEvent
  | TurnErrorEvent
  | TurnDoneEvent
  | AgentMessageEvent
  | AppLifecycleEvent
  | BlockStartEvent
  | BlockDeltaEvent
  | BlockCompleteEvent
  | BlockCanceledEvent
  | ConnectionEstablishedEvent;

export interface BaseEvent {
  v: 1;
  /** Server-assigned monotonic sequence number. */
  seq: number;
}

export interface TurnStartedEvent extends BaseEvent {
  type: "turn_started";
  turn_id: string;
  agent: string;
  ts: number;
}

export interface TurnErrorEvent extends BaseEvent {
  type: "error";
  turn_id?: string;
  agent: string;
  code: string;
  message: string;
  recoverable: boolean;
}

export interface TurnDoneEvent extends BaseEvent {
  type: "turn_done";
  turn_id: string;
  agent: string;
  status: "complete" | "aborted" | "error";
  /**
   * FRI-95: when status === "aborted", distinguishes worker-cooperative
   * (`"cooperative"`) from daemon-force-kill (`"forced"`) paths. The
   * dashboard uses this to pick the right terminal copy on the user-block
   * affordance without round-tripping through the error block. Omitted
   * when status !== "aborted".
   */
  abort_reason?: "cooperative" | "forced";
  usage?: TurnUsage;
}

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

/**
 * Notification that a user-visible block landed for `agent` (FIX_FORWARD
 * 2.8). Emitted whenever the daemon publishes a `block_complete` with
 * `role='assistant'` OR (`role='user'` AND `source='mail'`). The dashboard
 * uses this to decide whether to badge the agent in the sidebar — focused
 * agents drop the badge locally, unfocused agents accumulate it.
 *
 * `chat_reply` has been removed (FIX_FORWARD 2.1); this event is now
 * sourced exclusively from real block commits.
 */
export interface AgentMessageEvent extends BaseEvent {
  type: "agent_message";
  agent: string;
  turn_id: string;
  block_id: string;
  kind: "block_complete";
  /** Short truncated preview of the block content, for inbox-style UI. */
  preview?: string;
}

// Phase 5: `agent_lifecycle` + `agent_status` retired — Zero
// replicates the `agents` slice (Phase 2) so the dashboard sidebar
// reads spawn / archive / idle / working / stalled status directly
// from the row.

// Phase 5: `mail_delivered` retired — Zero replicates the `mail`
// slice (Phase 3.6); the dashboard's reactive query picks up new
// rows. `schedule_fired` retired — Zero replicates the `schedules`
// slice (and the `schedule_runs` history table) so the dashboard
// sees the row's last_run_at / last_run_id update directly.

// Phase 5: `evolve_critical` + `system_banner` retired. Both move
// to canonical Postgres tables (`evolve_proposals` count derives
// via Zero; `system_banners` per ADR-024 carries level + text).
// The dashboard sidebar surfaces will be wired up in Phase 6.

/**
 * Apps platform lifecycle event (FRI-78). Fires when an app is
 * installed, uninstalled, reloaded, or its on-disk folder disappeared
 * out from under us during boot reconciliation.
 */
export interface AppLifecycleEvent extends BaseEvent {
  type: "app_lifecycle";
  event: "installed" | "uninstalled" | "reloaded" | "orphaned";
  app: string;
  version?: string;
}

/* ---------------- Block-level streaming events (FIX_FORWARD WS-1) ---------------- */
// Per-content-block lifecycle: start → delta(s) → complete. The daemon writes
// the canonical `blocks` row before each `block_start` / `block_complete` so
// the row's `last_event_seq` always advances strictly before the matching SSE
// event lands (ADR-004 at block granularity, FIX_FORWARD 1.10).

export type BlockKind = "text" | "thinking" | "tool_use" | "tool_result" | "error";

export interface BlockStartEvent extends BaseEvent {
  type: "block_start";
  turn_id: string;
  agent: string;
  block_id: string;
  /** SDK assistant message id when available; null for user/system blocks. */
  message_id: string | null;
  block_index: number;
  /** 'user' | 'assistant' | 'system'. */
  role: string;
  kind: BlockKind;
  /** 'user_chat' | 'mail' | 'queue_inject' | 'sdk' | 'scratch' | 'agent_spawn' | 'schedule' | 'refork_notice' | null. */
  source: string | null;
  /** Tool metadata captured at start, when kind === 'tool_use'. */
  tool?: { id: string; name: string };
  ts: number;
}

export interface BlockDeltaEvent extends BaseEvent {
  type: "block_delta";
  turn_id: string;
  agent: string;
  block_id: string;
  /** Incremental payload. For text/thinking it's the delta string. For
   * tool_use it's a partial JSON fragment of the tool input. */
  delta: { text?: string; partial_json?: string };
}

export interface BlockCompleteEvent extends BaseEvent {
  type: "block_complete";
  turn_id: string;
  agent: string;
  block_id: string;
  message_id: string | null;
  block_index: number;
  role: string;
  kind: BlockKind;
  source: string | null;
  /** Final serialized content payload for the block; same shape as the
   * `content_json` column in the blocks table. */
  content_json: string;
  /** `queued` is a transient terminal state for user blocks that have been
   *  recorded in the DB but are still sitting in the worker's `nextPrompts`
   *  FIFO (in-flight turn ahead of them). When the worker drains the queue
   *  and actually dispatches the prompt, the daemon emits
   *  `block_meta_update` with `status='complete'` and a fresh `ts` so the
   *  block sorts inline with the surrounding stream rather than pinned to
   *  the bottom. */
  status: "complete" | "aborted" | "error" | "queued";
  ts: number;
}

/**
 * A previously-started block was cancelled before any content accumulated —
 * the SDK opened a `thinking` (or other) content block and the worker exited
 * the for-await loop (FRI-78 mid-turn-injection break) before any deltas
 * landed. The daemon deletes the row from `blocks` table and emits this so
 * live clients can drop the bubble. Without it, the dashboard would render
 * an empty "Thinking STOPPED" footer for a block that had no content to
 * disclose.
 */
export interface BlockCanceledEvent extends BaseEvent {
  type: "block_canceled";
  turn_id: string;
  agent: string;
  block_id: string;
}

// Phase 5: `block_meta_update` retired — Zero replicates the
// underlying queued → complete UPDATEs (and aborted DELETEs) on
// the blocks slice; the dashboard's reactive query re-sorts on
// the new ts automatically. Same removal applies to `block_reload`,
// which signaled JSONL-recovery INSERTs/UPDATEs that Zero now
// replicates without an SSE-triggered REST refetch.

/**
 * First SSE event the daemon emits on every new connection (FIX_FORWARD 1.6).
 * Carries the daemon's `boot_id` so clients can detect a daemon restart and
 * reset their per-agent cursors (`lastSeqByAgent`).
 */
export interface ConnectionEstablishedEvent extends BaseEvent {
  type: "connection_established";
  /** Stable UUID minted once per daemon boot. */
  boot_id: string;
  /** Wall-clock time when this daemon process started, in unix ms. The
   *  connectivity widget (FIX_FORWARD 3.10) shows daemon uptime computed
   *  from `Date.now() - boot_ts`. */
  boot_ts: number;
  /** Current ring-buffer head when the connection landed. */
  current_seq: number;
  ts: number;
}
