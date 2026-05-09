/**
 * IPC protocol between the daemon (parent) and the worker fork.
 *
 * Parent → Worker: WorkerCommand
 * Worker → Parent: WorkerEvent
 */

import type { AgentType, ThinkingConfig, ThinkingEffort } from "@friday/shared";

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
  | { type: "mail-wakeup" };

export type WorkerEvent =
  | { type: "ready" }
  | { type: "session-update"; sessionId: string }
  | { type: "text-delta"; text: string; messageId?: string }
  | { type: "tool-start"; toolId: string; toolName: string; input: unknown }
  | { type: "tool-input"; toolId: string; input: unknown }
  | {
      type: "tool-end";
      toolId: string;
      toolName: string;
      status: "ok" | "error";
      output?: string;
    }
  | { type: "thinking-start"; blockId: string }
  | { type: "thinking-delta"; blockId: string; text: string }
  | { type: "thinking-end"; blockId: string }
  | { type: "compaction-start" }
  | { type: "compaction-end"; result: "success" | "failed" }
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
