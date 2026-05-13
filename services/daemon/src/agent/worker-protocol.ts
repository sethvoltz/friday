/**
 * IPC protocol between the daemon (parent) and the worker fork.
 *
 * Parent → Worker: WorkerCommand
 * Worker → Parent: WorkerEvent
 */

import type {
  AgentType,
  McpServerConfig,
  ThinkingConfig,
  ThinkingEffort,
} from "@friday/shared";

export interface WorkerSpawnOptions {
  agentName: string;
  agentType: AgentType;
  workingDirectory: string;
  systemPrompt: string;
  resumeSessionId?: string;
  /** Per-turn allowed-tools restriction (skill `allowed_tools`). */
  allowedToolsOverride?: string[];
  /** Initial user prompt; the worker calls SDK `query()` with it. */
  prompt: string;
  /** Caller-supplied turn id (the daemon assigns one before spawn). */
  turnId: string;
  model: string;
  /** Thinking config from `~/.friday/config.json`. */
  thinking?: ThinkingConfig;
  /** Effort level (low | medium | high). */
  effort?: ThinkingEffort;
  /** Loopback port the worker's MCP handlers HTTP-call back to. */
  daemonPort: number;
  /** Parent agent's name (for builder/helper/bare). */
  parentName?: string;
  /** State directory for scheduled agents (state.md / last-run.md). */
  stateDir?: string;
  /**
   * `long-lived` workers run query → drain mail → waitForMail → loop until
   * an explicit stop. `one-shot` exits after `query()` finishes (scheduled).
   */
  mode: "long-lived" | "one-shot";
  /**
   * User-configured stdio MCP servers from `~/.friday/config.json`. Filtered
   * by the recipient worker's agent type against each entry's `scope`. The
   * daemon fills this from `loadConfig()` at spawn time; callers don't need
   * to set it themselves.
   */
  userMcpServers?: McpServerConfig[];
}

/**
 * Sent to a long-lived worker when a new user-driven turn arrives. The worker
 * resumes the SDK session if `resumeSessionId` is present, otherwise starts a
 * fresh session.
 */
export interface WorkerPromptCommand {
  prompt: string;
  turnId: string;
  resumeSessionId?: string;
  allowedToolsOverride?: string[];
}

export type WorkerCommand =
  | { type: "start"; options: WorkerSpawnOptions }
  | { type: "prompt"; options: WorkerPromptCommand }
  | { type: "stop" }
  | { type: "abort" }
  | { type: "mail-wakeup" }
  /**
   * Critical-priority mail just landed for this worker (FIX_FORWARD 2.4).
   * The worker breaks the current SDK iterator at the next assistant-
   * message boundary and lets `mainLoop` drain the inbox normally — the
   * critical mail will be the (at minimum) first row.
   */
  | { type: "mail-wakeup-critical" }
  /**
   * The parent has queued one or more user prompts for this worker via
   * `nextPrompts`. The worker breaks the current SDK iterator at the next
   * assistant-message boundary, emits `turn-complete`, and lets the
   * parent's turn-complete handler shift the queue and send a fresh
   * `prompt` IPC. FIX_FORWARD 2.4.
   */
  | { type: "prompts-pending" };

/**
 * Worker → parent block events. Each content block (text / thinking / tool_use
 * / tool_result) starts with `block-start`, accumulates content via zero or
 * more `block-delta`s, and finishes with `block-stop`. The worker assigns a
 * `clientBlockId` that's unique within the worker process — the daemon mints
 * the final UUID stored as `block_id` in the DB and uses `clientBlockId`
 * only to correlate delta/stop with the originating start.
 */
export type WorkerBlockKind = "text" | "thinking" | "tool_use" | "tool_result";

export interface WorkerBlockStart {
  type: "block-start";
  clientBlockId: string;
  kind: WorkerBlockKind;
  blockIndex: number;
  messageId?: string;
  /** Present when kind === 'tool_use'. */
  tool?: { id: string; name: string };
}

export interface WorkerBlockDelta {
  type: "block-delta";
  clientBlockId: string;
  /** Free-form delta. text for text/thinking; partial_json for tool_use input. */
  delta: { text?: string; partial_json?: string };
}

export interface WorkerBlockStop {
  type: "block-stop";
  clientBlockId: string;
  /** Final assembled JSON payload for the block, ready for DB persistence.
   * Daemon stores this verbatim as `content_json`. */
  contentJson: string;
  status: "complete" | "aborted" | "error";
}

export type WorkerEvent =
  | { type: "ready" }
  | { type: "session-update"; sessionId: string }
  | WorkerBlockStart
  | WorkerBlockDelta
  | WorkerBlockStop
  | {
      type: "turn-complete";
      sessionId: string;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_tokens: number;
        cache_read_tokens: number;
        cost_usd: number;
      };
    }
  | { type: "status-change"; status: "idle" | "working" }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "heartbeat" };
