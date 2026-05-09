/**
 * Worker lifecycle: forks per-agent processes, owns the IPC channel, and
 * routes events to the daemon's eventBus. Each forked worker can be either
 * one-shot (scheduled) or long-lived (orchestrator/builder/helper/bare).
 *
 * Long-lived semantics:
 *   - The first turn arrives via spawnTurn() with the initial prompt.
 *   - Subsequent turns arrive via dispatchTurn(); if the agent is already
 *     live we send a `prompt` IPC instead of forking.
 *   - turn-complete from the worker emits `turn_done` and inserts usage,
 *     but does NOT shut the worker down — the worker drives its own loop
 *     (drain mail, idle, repeat).
 *   - If a new prompt arrives while the worker is mid-turn, we queue it
 *     parent-side and flush on the next turn-complete so events from the
 *     in-flight turn keep their original turn_id.
 */

import { fork, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentType } from "@friday/shared";
import { insertUsage } from "@friday/shared/services";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import * as registry from "./registry.js";
import { startMirror } from "./jsonl-mirror.js";
import type {
  WorkerCommand,
  WorkerEvent,
  WorkerPromptCommand,
  WorkerSpawnOptions,
} from "./worker-protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "worker.js");

export interface ExitInfo {
  sessionId?: string;
  durationMs: number;
  /** Whether the parent observed a turn-complete before the exit. */
  completed: boolean;
  status: "complete" | "aborted" | "error";
}

interface LiveWorker {
  child: ChildProcess;
  agentName: string;
  agentType: AgentType;
  model: string;
  /** Active turn id; updated on each prompt dispatch. */
  turnId: string;
  sessionId?: string;
  abortRequested: boolean;
  textAccumulator: string;
  lastHeartbeat: number;
  /** Wall-clock start of the *current* turn, for usage duration. */
  turnStart: number;
  /** Wall-clock start of the worker process; used for one-shot duration. */
  spawnedAt: number;
  /** Idle vs working, mirrored from worker `status-change` events. */
  status: "idle" | "working";
  /**
   * FIFO of prompts that arrived while a previous turn was in flight. Drained
   * on each turn-complete so per-turn events stay tagged with the correct
   * turn_id.
   */
  nextPrompts: WorkerPromptCommand[];
  mode: "long-lived" | "one-shot";
  /** Set by handleEvent on turn-complete; consumed by onExit. */
  lastExitStatus: "complete" | "aborted" | "error";
  completedAtLeastOnce: boolean;
  onExit?: (info: ExitInfo) => void;
}

const live = new Map<string, LiveWorker>();

export interface SpawnTurnInput {
  agentName: string;
  options: WorkerSpawnOptions;
  /** Called when the worker process exits. Used by scheduled to write last-run.md. */
  onExit?: (info: ExitInfo) => void;
}

/**
 * Forks a fresh worker for `agentName` and starts the initial turn. Throws
 * if the agent already has a live worker — the caller should use
 * `dispatchTurn` instead, which handles both fork and reuse.
 */
export function spawnTurn(input: SpawnTurnInput): void {
  if (live.has(input.agentName)) {
    throw new Error(`agent "${input.agentName}" already has a live worker`);
  }
  registry.setStatus(input.agentName, "working");

  logger.log("info", "worker.fork", {
    agent: input.agentName,
    type: input.options.agentType,
    mode: input.options.mode,
    turnId: input.options.turnId,
    resumeSessionId: input.options.resumeSessionId ?? null,
  });

  const child = fork(WORKER_PATH, [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env },
  });
  const w: LiveWorker = {
    child,
    agentName: input.agentName,
    agentType: input.options.agentType,
    model: input.options.model,
    turnId: input.options.turnId,
    abortRequested: false,
    textAccumulator: "",
    lastHeartbeat: Date.now(),
    turnStart: Date.now(),
    spawnedAt: Date.now(),
    status: "working",
    nextPrompts: [],
    mode: input.options.mode,
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    onExit: input.onExit,
  };
  live.set(input.agentName, w);

  child.on("message", (raw: unknown) => {
    handleEvent(w, raw as WorkerEvent);
  });
  child.on("exit", (code, signal) => {
    logger.log("info", "worker.exit", {
      agent: input.agentName,
      code,
      signal,
    });
    live.delete(input.agentName);
    registry.setStatus(input.agentName, "idle");
    eventBus.publish({
      v: 1,
      type: "agent_lifecycle",
      agent: input.agentName,
      agentType: input.options.agentType,
      parentName: input.options.parentName,
      event: "complete",
    });
    if (w.onExit) {
      const status: ExitInfo["status"] = w.completedAtLeastOnce
        ? w.lastExitStatus
        : code === 0
          ? "complete"
          : "error";
      try {
        w.onExit({
          sessionId: w.sessionId,
          durationMs: Date.now() - w.spawnedAt,
          completed: w.completedAtLeastOnce,
          status,
        });
      } catch (err) {
        logger.log("warn", "worker.onexit.error", {
          agent: input.agentName,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  // Send `start` after the worker emits its first `ready`.
  child.once("message", () => {
    send(child, { type: "start", options: input.options });
  });

  eventBus.publish({
    v: 1,
    type: "agent_lifecycle",
    agent: input.agentName,
    agentType: input.options.agentType,
    parentName: input.options.parentName,
    event: "spawn",
  });
  eventBus.publish({
    v: 1,
    type: "turn_started",
    turn_id: input.options.turnId,
    agent: input.agentName,
    ts: Date.now(),
  });
}

/**
 * Smart entrypoint for "send a turn to this agent". Forks a fresh worker if
 * the agent isn't live; otherwise sends a `prompt` IPC (or queues it if the
 * worker is mid-turn).
 */
export function dispatchTurn(input: SpawnTurnInput): void {
  const existing = live.get(input.agentName);
  if (!existing) {
    spawnTurn(input);
    return;
  }
  const promptCmd: WorkerPromptCommand = {
    prompt: input.options.prompt,
    turnId: input.options.turnId,
    resumeSessionId:
      input.options.resumeSessionId ?? existing.sessionId ?? undefined,
    allowedToolsOverride: input.options.allowedToolsOverride,
  };
  if (existing.status === "idle") {
    sendPrompt(existing, promptCmd);
  } else {
    existing.nextPrompts.push(promptCmd);
    logger.log("info", "worker.prompt.queued", {
      agent: input.agentName,
      turnId: promptCmd.turnId,
      depth: existing.nextPrompts.length,
    });
  }
}

function sendPrompt(w: LiveWorker, p: WorkerPromptCommand): void {
  w.turnId = p.turnId;
  w.turnStart = Date.now();
  w.abortRequested = false;
  w.status = "working";
  registry.setStatus(w.agentName, "working");
  eventBus.publish({
    v: 1,
    type: "turn_started",
    turn_id: p.turnId,
    agent: w.agentName,
    ts: Date.now(),
  });
  send(w.child, { type: "prompt", options: p });
}

export function abortTurn(agentName: string): boolean {
  const w = live.get(agentName);
  if (!w) return false;
  w.abortRequested = true;
  send(w.child, { type: "abort" });
  return true;
}

export function killAgent(agentName: string): boolean {
  const w = live.get(agentName);
  if (w) {
    send(w.child, { type: "stop" });
    // Hard-kill backstop: if worker doesn't exit on its own, force.
    setTimeout(() => {
      if (!w.child.killed) w.child.kill("SIGTERM");
    }, 5_000).unref();
    live.delete(agentName);
  }
  registry.destroyAgent(agentName);
  eventBus.publish({
    v: 1,
    type: "agent_lifecycle",
    agent: agentName,
    agentType: w?.agentType ?? "orchestrator",
    event: "kill",
  });
  return true;
}

/**
 * Send a `mail-wakeup` IPC to a live worker so it drains its inbox without
 * waiting for the 60s idle timeout. Returns true if delivered, false if the
 * agent isn't currently live.
 */
export function wakeAgent(agentName: string): boolean {
  const w = live.get(agentName);
  if (!w) return false;
  send(w.child, { type: "mail-wakeup" });
  return true;
}

export function isAgentLive(agentName: string): boolean {
  return live.has(agentName);
}

export function liveAgentNames(): string[] {
  return [...live.keys()];
}

/**
 * Watchdog-only readonly peek at a live worker. Returns a frozen view of the
 * fields the watchdog needs; never returns the LiveWorker itself, so callers
 * can't mutate the live map by accident.
 */
export function peekLiveWorker(agentName: string): {
  status: "idle" | "working";
  lastHeartbeat: number;
  agentType: AgentType;
  turnId: string;
} | null {
  const w = live.get(agentName);
  if (!w) return null;
  return {
    status: w.status,
    lastHeartbeat: w.lastHeartbeat,
    agentType: w.agentType,
    turnId: w.turnId,
  };
}

function handleEvent(w: LiveWorker, e: WorkerEvent): void {
  w.lastHeartbeat = Date.now();
  switch (e.type) {
    case "session-update":
      w.sessionId = e.sessionId;
      registry.setSession(w.agentName, e.sessionId);
      startMirror({
        sessionId: e.sessionId,
        agentName: w.agentName,
        workingDirectory: process.cwd(),
      });
      break;
    case "text-delta": {
      w.textAccumulator += e.text;
      eventBus.publish({
        v: 1,
        type: "text_delta",
        turn_id: w.turnId,
        agent: w.agentName,
        text: e.text,
        message_id: e.messageId,
      });
      break;
    }
    case "tool-start":
      eventBus.publish({
        v: 1,
        type: "tool_use_start",
        turn_id: w.turnId,
        agent: w.agentName,
        tool_id: e.toolId,
        tool_name: e.toolName,
        input: e.input,
      });
      break;
    case "tool-input":
      eventBus.publish({
        v: 1,
        type: "tool_use_input",
        turn_id: w.turnId,
        agent: w.agentName,
        tool_id: e.toolId,
        input: e.input,
      });
      break;
    case "tool-end":
      eventBus.publish({
        v: 1,
        type: "tool_use_end",
        turn_id: w.turnId,
        agent: w.agentName,
        tool_id: e.toolId,
        status: e.status,
        output: e.output,
      });
      break;
    case "thinking-start":
      eventBus.publish({
        v: 1,
        type: "thinking_start",
        turn_id: w.turnId,
        agent: w.agentName,
        block_id: e.blockId,
      });
      break;
    case "thinking-delta":
      eventBus.publish({
        v: 1,
        type: "thinking_delta",
        turn_id: w.turnId,
        agent: w.agentName,
        block_id: e.blockId,
        text: e.text,
      });
      break;
    case "thinking-end":
      eventBus.publish({
        v: 1,
        type: "thinking_end",
        turn_id: w.turnId,
        agent: w.agentName,
        block_id: e.blockId,
      });
      break;
    case "compaction-start":
      eventBus.publish({
        v: 1,
        type: "compaction_start",
        turn_id: w.turnId,
        agent: w.agentName,
      });
      break;
    case "compaction-end":
      eventBus.publish({
        v: 1,
        type: "compaction_end",
        turn_id: w.turnId,
        agent: w.agentName,
        result: e.result,
      });
      break;
    case "error":
      w.lastExitStatus = w.abortRequested ? "aborted" : "error";
      eventBus.publish({
        v: 1,
        type: "error",
        turn_id: w.turnId,
        agent: w.agentName,
        code: w.abortRequested ? "aborted" : "worker_error",
        message: e.message,
        recoverable: e.recoverable,
      });
      break;
    case "status-change":
      w.status = e.status;
      eventBus.publish({
        v: 1,
        type: "agent_status",
        agent: w.agentName,
        status: e.status === "working" ? "working" : "idle",
        since: Date.now(),
      });
      break;
    case "turn-complete": {
      const durationMs = Date.now() - w.turnStart;
      eventBus.publish({
        v: 1,
        type: "turn_done",
        turn_id: w.turnId,
        agent: w.agentName,
        status: w.abortRequested ? "aborted" : "complete",
        usage: e.usage
          ? {
              input_tokens: e.usage.input_tokens,
              output_tokens: e.usage.output_tokens,
              cache_creation_tokens: e.usage.cache_creation_tokens,
              cache_read_tokens: e.usage.cache_read_tokens,
              cost_usd: e.usage.cost_usd,
            }
          : undefined,
      });
      if (e.usage && (w.sessionId || e.sessionId)) {
        try {
          insertUsage({
            timestamp: new Date().toISOString(),
            sessionId: w.sessionId ?? e.sessionId,
            agentName: w.agentName,
            agentType: w.agentType,
            model: w.model,
            costUsd: e.usage.cost_usd,
            inputTokens: e.usage.input_tokens,
            outputTokens: e.usage.output_tokens,
            cacheCreationTokens: e.usage.cache_creation_tokens,
            cacheReadTokens: e.usage.cache_read_tokens,
            durationMs,
          });
        } catch (err) {
          logger.log("warn", "usage.insert.error", {
            agent: w.agentName,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Long-lived worker: flush queued prompt if any. Don't send `stop` — the
      // worker manages its own lifecycle.
      w.status = "idle";
      w.completedAtLeastOnce = true;
      w.lastExitStatus = w.abortRequested ? "aborted" : "complete";
      registry.setStatus(w.agentName, "idle");
      const next = w.nextPrompts.shift();
      if (next) sendPrompt(w, next);
      break;
    }
    case "heartbeat":
      // No SSE wire event yet; lastHeartbeat update at top of handler is
      // enough for the Phase 6 watchdog.
      break;
    case "ready":
      // Already handled by the once() listener that sends `start`.
      break;
  }
}

function send(child: ChildProcess, cmd: WorkerCommand): void {
  if (child.send) child.send(cmd);
}
