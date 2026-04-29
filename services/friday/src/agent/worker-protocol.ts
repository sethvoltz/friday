/**
 * IPC message types between the daemon supervisor and forked agent workers.
 *
 * WorkerCommand: parent daemon → child worker
 * WorkerEvent:   child worker → parent daemon
 */

// ── Commands: daemon → worker ─────────────────────────────────────────────

export type WorkerCommand =
  | { type: "start"; options: WorkerSpawnOptions }
  | { type: "stop" }
  | { type: "mail-wakeup" };

/**
 * Fully serialisable spawn config passed to the worker on startup.
 * MCP servers are reconstructed inside the worker from these fields.
 */
export interface WorkerSpawnOptions {
  agentName: string;
  agentType: "builder" | "helper";
  cwd: string;
  /** Daemon's configured working directory — needed so agent-tools can scope themselves */
  workingDirectory: string;
  model: string;
  allowedTools: string[];
  epicId?: string | null;
  taskId?: string | null;
  parent?: string;
  workspace?: string;
  resumeSessionId?: string;
}

// ── Events: worker → daemon ───────────────────────────────────────────────

export type WorkerEvent =
  /** A text chunk was received from the SDK stream — proves forward progress */
  | { type: "chunk-received" }
  /** A tool call has started; the agent is now executing a tool */
  | { type: "tool-start"; toolName: string }
  /** A tool call has finished; the tool result was returned to the model */
  | { type: "tool-end"; toolName: string }
  /** Agent sent mail and is about to enter idle-wait; not a stall candidate */
  | { type: "mail-sent" }
  /** A new session ID was assigned or updated */
  | { type: "session-update"; sessionId: string }
  /** Per-turn cost and token usage */
  | { type: "usage"; payload: WorkerUsagePayload }
  /** A turn completed successfully */
  | { type: "turn-complete"; sessionId: string }
  /** Agent changed status (active ↔ idle) */
  | { type: "status-change"; status: "active" | "idle" }
  /** Files accessed during the turn (Read/Write/Edit) */
  | { type: "file-access"; turn: number; files: string[] }
  /** Worker encountered a non-fatal error */
  | { type: "error"; message: string };

export interface WorkerUsagePayload {
  sessionId: string;
  model: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turnNumber: number;
  durationMs: number;
}
