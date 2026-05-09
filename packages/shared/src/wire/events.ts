/**
 * Wire schema for the SSE channel between daemon → SvelteKit → browser.
 *
 * Single SSE stream at GET /api/events. Per-turn POST returns a turn_id
 * immediately; the streaming events flow on this channel tagged with that id.
 *
 * All events carry `v: 1` for forward-compat. Server-assigned `seq` is used
 * for replay via `Last-Event-ID`.
 */

import type { AgentStatus, AgentType } from "../agents.js";

export type WireEvent =
  | TurnStartedEvent
  | TextDeltaEvent
  | ToolUseStartEvent
  | ToolUseInputEvent
  | ToolUseEndEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | TurnErrorEvent
  | TurnDoneEvent
  | AgentMessageEvent
  | AgentLifecycleEvent
  | AgentStatusEvent
  | MailDeliveredEvent
  | ScheduleFiredEvent
  | EvolveCriticalEvent
  | SystemBannerEvent;

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

export interface TextDeltaEvent extends BaseEvent {
  type: "text_delta";
  turn_id: string;
  /** Agent that owns this turn — required so the dashboard can route deltas
   * to the right chat view without a turn_id→agent lookup table. */
  agent: string;
  text: string;
  /** SDK message id for the assistant message this delta belongs to. The
   * dashboard uses it to dedupe against DB-loaded bubbles (whose stable id
   * is also derived from this message id), so a refresh mid-stream doesn't
   * leave two copies of the same content. */
  message_id?: string;
}

export interface ToolUseStartEvent extends BaseEvent {
  type: "tool_use_start";
  turn_id: string;
  agent: string;
  tool_id: string;
  tool_name: string;
  input: unknown;
}

export interface ToolUseInputEvent extends BaseEvent {
  type: "tool_use_input";
  turn_id: string;
  agent: string;
  tool_id: string;
  /** The fully-assembled input JSON, parsed from streamed `input_json_delta`. */
  input: unknown;
}

export interface ToolUseEndEvent extends BaseEvent {
  type: "tool_use_end";
  turn_id: string;
  agent: string;
  tool_id: string;
  status: "ok" | "error";
  /** Full tool result text. Matches what `extractBlocks` reads from the
   * persisted JSONL row, so live and historical render are identical. */
  output?: string;
}

export interface ThinkingStartEvent extends BaseEvent {
  type: "thinking_start";
  turn_id: string;
  agent: string;
  block_id: string;
}

export interface ThinkingDeltaEvent extends BaseEvent {
  type: "thinking_delta";
  turn_id: string;
  agent: string;
  block_id: string;
  text: string;
}

export interface ThinkingEndEvent extends BaseEvent {
  type: "thinking_end";
  turn_id: string;
  agent: string;
  block_id: string;
}

export interface CompactionStartEvent extends BaseEvent {
  type: "compaction_start";
  turn_id?: string;
  agent: string;
}

export interface CompactionEndEvent extends BaseEvent {
  type: "compaction_end";
  turn_id?: string;
  agent: string;
  result: "success" | "failed";
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

export interface AgentMessageEvent extends BaseEvent {
  type: "agent_message";
  agent: string;
  turn_id: string;
  preview: string;
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
  event: "spawn" | "kill" | "crash" | "refork" | "complete";
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
