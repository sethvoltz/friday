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
  /** Attachments referenced by the initial prompt. Empty/omitted on
   *  non-user_chat dispatch paths (mail, scheduled). When present, the
   *  worker switches to the SDK's async-iterable form and embeds
   *  `{type:"image"|"document"}` content blocks alongside the text. */
  attachments?: WorkerAttachment[];
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
  /** Attachments referenced by this prompt. Treated as empty when omitted. */
  attachments?: WorkerAttachment[];
  turnId: string;
  resumeSessionId?: string;
  allowedToolsOverride?: string[];
  /** The DB `blocks.block_id` of the user-chat block that backs this prompt,
   *  when the daemon recorded the user block before dispatch. Populated for
   *  `user_chat` POSTs (initial or queued); omitted for mail/scheduled
   *  injection where no user block is written.  Used by the dispatch path
   *  to flip a queued block to `complete` with a fresh `ts` via
   *  `block_meta_update`. */
  userBlockId?: string;
}

/** Metadata for an attachment referenced by a turn. Resolved to bytes on
 *  disk by the worker when building the SDK user message. */
export interface WorkerAttachment {
  sha256: string;
  filename: string;
  mime: string;
}

export type WorkerCommand =
  | { type: "start"; options: WorkerSpawnOptions }
  | { type: "prompt"; options: WorkerPromptCommand }
  | { type: "stop" }
  | { type: "abort" }
  | { type: "mail-wakeup" }
  /**
   * Critical-priority mail just landed for this worker (FIX_FORWARD 2.4).
   * The worker breaks the current SDK iterator at the next safe iteration
   * boundary and lets `mainLoop` drain the inbox normally — the critical
   * mail will be the (at minimum) first row.
   *
   * FRI-78: "next safe boundary" means the next `user`(tool_results)
   * message if the just-yielded assistant message carried tool_uses,
   * otherwise the assistant boundary itself. Breaking before the matching
   * tool_results land would leave the SDK session JSONL with a dangling
   * `assistant→tool_use` and the next `runQuery`'s resume fails with
   * "Stream closed" on the model's first tool dispatch.
   */
  | { type: "mail-wakeup-critical" }
  /**
   * The parent has queued one or more user prompts for this worker via
   * `nextPrompts`. The worker breaks the current SDK iterator at the next
   * safe iteration boundary (see `mail-wakeup-critical` for the FRI-78
   * detail on tool_use/tool_results ordering), emits `turn-complete`, and
   * lets the parent's turn-complete handler shift the queue and send a
   * fresh `prompt` IPC. FIX_FORWARD 2.4.
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

/**
 * FRI-78 follow-up: a block that was started (block-start fired) but is being
 * cancelled because it never accumulated any content. The canonical case is
 * `flushBoundaryBlocks` at a pending-injection break: the SDK opened a
 * `thinking` block but produced no deltas before the worker exited the
 * for-await loop. Without this, an empty `aborted` row leaks into the DB and
 * the dashboard paints a "Thinking STOPPED" footer for a block that had no
 * content. The daemon's handler DELETEs the row and publishes
 * `block_canceled` SSE so live clients drop the bubble.
 */
export interface WorkerBlockCancel {
  type: "block-cancel";
  clientBlockId: string;
}

export type WorkerEvent =
  | { type: "ready" }
  | { type: "session-update"; sessionId: string }
  | WorkerBlockStart
  | WorkerBlockDelta
  | WorkerBlockStop
  | WorkerBlockCancel
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
  | {
      type: "error";
      message: string;
      recoverable: boolean;
      /** Structured fields from `classifySdkError`. Absent on the abort
       *  branch (the daemon synthesizes its own headline for stops). */
      code?: string;
      headline?: string;
      httpStatus?: number;
      retryAfterSeconds?: number;
      requestId?: string;
      rawMessage?: string;
    }
  | { type: "heartbeat" };
