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
 * (`block_start`, `block_delta`, `block_complete`, `block_reload`). The
 * `connection_established` event is sent first on every new SSE connection
 * to carry the daemon's `boot_id` (FIX_FORWARD 1.6) — clients reset their
 * per-agent cursors on `boot_id` mismatch.
 */

import type { AgentStatus, AgentType } from "../agents.js";

export type WireEvent =
  | TurnStartedEvent
  | TurnErrorEvent
  | TurnDoneEvent
  | AgentMessageEvent
  | AgentLifecycleEvent
  | AgentStatusEvent
  | MailDeliveredEvent
  | ScheduleFiredEvent
  | EvolveCriticalEvent
  | SystemBannerEvent
  | BlockStartEvent
  | BlockDeltaEvent
  | BlockCompleteEvent
  | BlockReloadEvent
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

export interface AgentLifecycleEvent extends BaseEvent {
  type: "agent_lifecycle";
  agent: string;
  agentType: AgentType;
  /** Name of the agent that spawned this one, when known. The dashboard uses
   * this to attach the spawn message to the spawner's chat (not the focused
   * agent's, which may be unrelated). Undefined for top-level agents like the
   * orchestrator and bare scratch agents created from a system command. */
  parentName?: string;
  event: "spawn" | "archive" | "crash" | "refork" | "complete";
  reason?: string;
}

export interface AgentStatusEvent extends BaseEvent {
  type: "agent_status";
  agent: string;
  status: AgentStatus;
  since: number;
}

export interface MailDeliveredEvent extends BaseEvent {
  type: "mail_delivered";
  mail_id: number;
  from: string;
  to: string;
}

export interface ScheduleFiredEvent extends BaseEvent {
  type: "schedule_fired";
  schedule: string;
  run_id: string;
}

export interface EvolveCriticalEvent extends BaseEvent {
  type: "evolve_critical";
  proposal_id: string;
  count: number;
}

export interface SystemBannerEvent extends BaseEvent {
  type: "system_banner";
  level: "info" | "warn" | "error";
  text: string;
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
  /** 'user_chat' | 'mail' | 'queue_inject' | 'sdk' | null. */
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
  status: "complete" | "aborted" | "error";
  ts: number;
}

/**
 * Emitted by the daemon when boot-time JSONL recovery (FIX_FORWARD 1.3) has
 * INSERTed or UPDATEd canonical blocks that an SSE client should refetch.
 * Carries the affected block ids so clients can decide whether to refetch
 * the focused agent's history.
 */
export interface BlockReloadEvent extends BaseEvent {
  type: "block_reload";
  agent: string;
  /** Sessions touched by the recovery scan. */
  session_id: string;
  block_ids: string[];
  /** Number of net-new blocks inserted by recovery. */
  inserted: number;
  /** Number of existing blocks whose content was refreshed. */
  updated: number;
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
