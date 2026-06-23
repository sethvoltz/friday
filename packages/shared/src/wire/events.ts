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
  | ConnectionEstablishedEvent
  | CompactingEvent
  | WorkerNoMailBackEvent
  | WorkerForceKillDeadLetterEvent
  | ElicitationRequestedEvent
  | ToastEvent;

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
  /**
   * FRI-60: present only when the turn produced zero content blocks.
   * Distinguishes the cause so the dashboard can show the right copy
   * on the "Agent didn't respond" affordance:
   *   - "abort"              — user-requested stop raced to completion
   *   - "compaction"         — SDK compact_boundary was seen this turn
   *   - "sdk-resume-failure" — SDK returned empty result (e.g. missing transcript)
   */
  zero_block_reason?: "abort" | "compaction" | "sdk-resume-failure";
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
// Per-content-block lifecycle: start → delta(s) → complete. Phase 5 / ADR-024:
// the canonical `blocks` row is written only on `block_complete` with
// `streaming=false`; deltas live in the daemon's in-memory accumulator
// (`block-stream.ts`) and ride per-agent SSE only. The dashboard's
// `lastSeqByAgent` cursor dedupes replayed events at apply time using the
// `seq` field stamped onto each frame by `eventBus.publish`. FRI-125 retired
// the row-level `last_event_seq` column and the seq-stamping dance that used
// to keep the row and the SSE event in sync; the SSE `seq` is the only
// sequence anyone reads now.

export type BlockKind =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "error"
  | "mail"
  | "compaction";

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
 * FRI-156 §F: live compaction-in-progress signal. Fired at the START of a
 * compaction (`phase:'start'`) so the dashboard can show a "Compacting
 * context…" spinner, and again at the END (`phase:'done'`, with `result`)
 * when the compaction settles. This is purely a transient lifecycle signal —
 * the durable artifact is the `kind:'compaction'` block row (written by the
 * daemon's compaction-boundary handler), which replicates via Zero and
 * survives reload. The retired `compaction` event (FRI-60 Phase B inline
 * notice + its `pre_tokens`/`post_tokens`/`duration_ms` payload) is now
 * carried by that block's `content_json` instead, so this event omits the
 * token deltas.
 */
export interface CompactingEvent extends BaseEvent {
  type: "compacting";
  agent: string;
  turn_id: string;
  /** 'start' when the SDK begins compacting; 'done' when it settles. The
   *  dashboard only toggles the transient "Compacting context…" spinner on
   *  phase. The closing-frame OUTCOME (success/failed) + any compact_error are
   *  logged daemon-side under `worker.compact.result` (FRI-156 §F / AC8); they
   *  are NOT carried on this wire event because no client consumes them. */
  phase: "start" | "done";
}

/**
 * FRI-127 §5 (mail-back backstop, Option C). Fired when a helper/builder
 * completes a turn without mailing its parent for the SECOND consecutive
 * turn — i.e. the single-fire Option-B nudge already ran and the child still
 * didn't report back. The dashboard surfaces this as a "child finished
 * without mailing" affordance with a manual Nudge action. `streak` is the
 * count of consecutive no-mail-back turn-completes (≥2 when this fires).
 */
export interface WorkerNoMailBackEvent extends BaseEvent {
  type: "worker.no-mail-back";
  agent: string;
  turn_id: string;
  streak: number;
}

/**
 * FRI-154: emitted when a worker has been force-killed (SIGTERM/SIGKILL/OOM/
 * watchdog/abort) with unprocessed mail at `delivery='pending'` more times
 * than the anti-loop gate permits in its rolling window. The respawn timer is
 * NOT scheduled when this fires; the affected mail rows are marked with
 * `meta_json.dead_letter` so a future fresh-mail-arrival path (which also
 * filters dead-lettered mail) doesn't silently re-resurrect them.
 *
 * Operator recovery: `agent_archive` + recreate, manual SQL to clear the
 * sentinel, or `mail_close` on each dead-lettered row.
 */
export interface WorkerForceKillDeadLetterEvent extends BaseEvent {
  type: "worker.force-kill.dead-letter";
  agent: string;
  /** Count of consecutive respawn attempts in the current window before
   *  the gate tripped (== `RESPAWN_MAX_ATTEMPTS` at fire time). */
  attempts: number;
  /** The rolling window in milliseconds that anchored the streak. */
  window_ms: number;
  /** Count of pending mail rows for this agent at dead-letter time. */
  unprocessed_mail_count: number;
  /** Wall-clock of the agent's last observed `turn-complete`, if any.
   *  Null when the agent has never completed a turn under this daemon
   *  process (in-memory bookkeeping resets on restart). */
  last_successful_turn_complete_at: number | null;
  ts: number;
}

/**
 * FRI-152: fired when an agent's `mcp__friday-elicitation__ask_user` tool
 * call lands and the daemon registers an in-memory waiter for the user's
 * answer. The dashboard already has the tool_use block (with the questions
 * payload) via Zero — this event is the side-channel signal that the
 * worker is currently AWAITING the answer (i.e. the panel should render
 * with active controls, not as a stale historical tool call). Once the
 * user submits, the resolver fires, the MCP handler returns, the SDK
 * emits a normal `tool_result` block, and the dashboard locks the panel
 * on `msg.output` populated — no separate "resolved" event needed.
 *
 * Carries no `questions` payload because the dashboard reads them off
 * the canonical tool_use block (replicated via Zero). This event is
 * purely a "panel is live" signal.
 */
export interface ElicitationRequestedEvent extends BaseEvent {
  type: "elicitation_requested";
  agent: string;
  turn_id: string;
  /** SDK tool_use_id of the `ask_user` call. Same id the daemon's
   *  in-memory waiter map is keyed on; same id the dashboard POSTs
   *  to `/api/elicitation/<id>/submit` to resolve. */
  tool_use_id: string;
  ts: number;
}

/**
 * FRI-142 (ADR-048): an ephemeral in-app Notification toast.
 *
 * This is the **Toast** Channel — fired by the daemon's stateless Notification
 * router (NOT a turn event) when policy × presence × DND resolves `toast` for an
 * event and the user is present on this client. It has NO backing DB row BY
 * DESIGN — a Notification is a transient delivery, never persisted (the durable
 * record is the `inbox_items` row / OS tray / deep-linked artifact). This is
 * why it rides SSE (ADR-024: SSE = ephemeral/live) rather than Zero; it is NOT
 * a resurrection of the Phase-5-retired SSE notification events (those had rows
 * and moved to Zero precisely because they were settled state).
 *
 * The dashboard renders a self-dismissing toast; clicking it navigates to
 * `deep_link`. `event_type` is the originating `NotifyEventType` (for grouping /
 * styling); `priority` mirrors the NotifyEvent priority.
 */
export interface ToastEvent extends BaseEvent {
  type: "toast";
  /** Short notification title (toast headline). */
  title: string;
  /** One-line body. */
  body: string;
  /** Route to navigate to on click; omitted when the toast is not actionable. */
  deep_link?: string;
  /** The originating Notification event id (a `NotifyEventType` value). */
  event_type: string;
  /** Mirrors NotifyEvent.priority ('normal' | 'critical'); omitted ⇒ normal. */
  priority?: "normal" | "critical";
  ts: number;
}

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
