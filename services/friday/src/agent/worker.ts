/**
 * Agent worker — runs as a child_process.fork() child.
 *
 * Lifecycle:
 *   1. Parent sends { type: "start", options } via IPC
 *   2. Worker runs the agent loop, emitting WorkerEvents
 *   3. Parent sends { type: "stop" } for graceful shutdown or SIGKILL for hard kill
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildAgentSystemPrompt, buildFirstTurnPrompt } from "./prime.js";
import { createMailTools } from "../comms/mail-tools.js";
import { mailCheck, mailEvents, buildMailPrompt } from "../comms/mail.js";
import { createAgentTools } from "./agent-tools.js";
import { logUsage } from "../monitor/usage.js";
import { log } from "../log.js";
import { updateAgentSession, updateAgentStatus } from "../sessions/registry.js";
import type { WorkerCommand, WorkerEvent, WorkerSpawnOptions } from "./worker-protocol.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function emit(event: WorkerEvent): void {
  process.send?.(event);
}

// ── File access tracking (per-turn) ──────────────────────────────────────

const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

function extractFilePath(toolName: string, toolInput: unknown): string | null {
  if (!FILE_TOOLS.has(toolName)) return null;
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const fp = (toolInput as Record<string, unknown>).file_path;
  return typeof fp === "string" ? fp : null;
}

// ── Agent name (set on start, used by mail wakeup handler) ────────────────

let currentAgentName = "";
const abort = new AbortController();
let started = false;

// ── IPC command handler ───────────────────────────────────────────────────

process.on("message", (msg: WorkerCommand) => {
  if (msg.type === "start" && !started) {
    started = true;
    runAgentLoop(msg.options, abort.signal).catch((err) => {
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
  } else if (msg.type === "stop") {
    abort.abort();
  } else if (msg.type === "mail-wakeup") {
    // Wake the idle waitForMail() promise by emitting the mail event locally
    mailEvents.emit(`mail:${currentAgentName}`);
  }
});

// ── Agent loop ────────────────────────────────────────────────────────────

async function runAgentLoop(
  options: WorkerSpawnOptions,
  signal: AbortSignal
): Promise<void> {
  const {
    agentName,
    agentType,
    cwd,
    workingDirectory,
    model,
    allowedTools,
    epicId,
    taskId,
    parent,
    workspace,
  } = options;

  currentAgentName = agentName;

  const systemPrompt = buildAgentSystemPrompt({
    agentName,
    agentType,
    epicId,
    taskId,
    cwd,
    parent,
    workspace,
  });

  const firstTurnPrompt = buildFirstTurnPrompt({
    agentName,
    agentType,
    epicId,
    taskId,
    cwd,
    parent,
    workspace,
  });

  let sessionId = options.resumeSessionId ?? undefined;
  let prompt = sessionId ? undefined : firstTurnPrompt;

  if (sessionId && !prompt) {
    prompt =
      "You have been resumed after a restart. Check your current task status " +
      "with `bd ready --json` and continue where you left off.";
  }

  // Reconstruct MCP servers inside the worker process
  const mailMcp = createMailTools({ callerName: agentName });
  const agentMcp = createAgentTools({
    callerName: agentName,
    callerType: agentType === "builder" ? "builder" : "builder",
    workingDirectory,
    model,
  });

  const allMcpServers: Record<string, any> = {
    "friday-mail": mailMcp,
    "friday-agents": agentMcp,
  };

  const queryOptions: Record<string, any> = {
    allowedTools,
    cwd,
    model,
    permissionMode: "bypassPermissions",
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: systemPrompt,
    },
    mcpServers: allMcpServers,
  };

  let turnNumber = 0;
  log("info", "worker_loop_start", { agent: agentName, resuming: !!sessionId });

  while (!signal.aborted) {
    // Per-turn file tracking
    const turnFiles = new Set<string>();
    // Track tool lifecycle for tool-start / tool-end IPC
    let pendingToolName: string | null = null;

    const emitToolEnd = () => {
      if (pendingToolName !== null) {
        emit({ type: "tool-end", toolName: pendingToolName });
        pendingToolName = null;
      }
    };

    try {
      for await (const message of query({
        prompt: prompt!,
        options: sessionId ? { ...queryOptions, resume: sessionId } : queryOptions,
      })) {
        if (signal.aborted) break;

        // Text output → chunk heartbeat (also ends any pending tool)
        if (message.type === "assistant") {
          const text = message.message.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("");
          if (text) {
            emitToolEnd();
            emit({ type: "chunk-received" });
          }
        }

        // Tool invocation → tool-start + file tracking
        if (message.type === "tool_progress") {
          const toolName = (message as any).tool_name;
          if (typeof toolName === "string" && toolName.length > 0) {
            // Consecutive tool calls: close previous before opening next
            emitToolEnd();
            pendingToolName = toolName;
            emit({ type: "tool-start", toolName });

            // Collect file paths from Read/Write/Edit
            const filePath = extractFilePath(toolName, (message as any).tool_input);
            if (filePath) turnFiles.add(filePath);
          }
        }

        // Turn result
        if (message.type === "result") {
          emitToolEnd();

          if (message.subtype === "success") {
            sessionId = message.session_id;
            turnNumber++;

            updateAgentSession(agentName, sessionId);
            emit({ type: "session-update", sessionId });

            const usage = (message as any).usage;
            const costUsd = (message as any).total_cost_usd ?? null;
            const durationMs = (message as any).duration_ms ?? 0;

            logUsage(
              {
                timestamp: new Date().toISOString(),
                channelId: "",
                sessionType: agentType,
                sessionId,
                model,
                costUsd,
                inputTokens: usage?.input_tokens ?? 0,
                outputTokens: usage?.output_tokens ?? 0,
                cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
                cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
                turnNumber,
                durationMs,
              },
              agentName
            );

            emit({
              type: "usage",
              payload: {
                sessionId,
                model,
                costUsd,
                inputTokens: usage?.input_tokens ?? 0,
                outputTokens: usage?.output_tokens ?? 0,
                cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
                cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
                turnNumber,
                durationMs,
              },
            });

            emit({ type: "file-access", turn: turnNumber, files: [...turnFiles] });
            emit({ type: "turn-complete", sessionId });

            log("info", "worker_turn_complete", { agent: agentName, sessionId });
          } else {
            emit({ type: "error", message: `Turn ended: ${message.subtype}` });
            log("warn", "worker_turn_failed", { agent: agentName, subtype: message.subtype });
          }
        }
      }
    } catch (err) {
      emitToolEnd();
      emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      log("error", "worker_loop_query_error", {
        agent: agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (signal.aborted) break;

    // Inter-turn mail check
    const mailPrompt = buildMailPrompt(agentName);
    if (mailPrompt) {
      prompt = mailPrompt;
      log("info", "worker_loop_mail_wakeup", { agent: agentName });
      continue;
    }

    // Going idle — signal to supervisor that we're not stalled, just waiting
    updateAgentStatus(agentName, "idle");
    emit({ type: "status-change", status: "idle" });
    emit({ type: "mail-sent" });
    log("info", "worker_loop_idle", { agent: agentName });

    // Idle wait loop (guards against spurious wakeups)
    while (!signal.aborted) {
      await waitForMail(agentName, signal);
      if (signal.aborted) break;

      const idleMailPrompt = buildMailPrompt(agentName);
      if (idleMailPrompt) {
        prompt = idleMailPrompt;
        updateAgentStatus(agentName, "active");
        emit({ type: "status-change", status: "active" });
        log("info", "worker_loop_mail_wakeup_from_idle", { agent: agentName });
        break;
      }
      log("debug", "worker_loop_idle_spurious_wakeup", { agent: agentName });
    }
  }

  log("info", "worker_loop_exit", { agent: agentName });
}

// ── Mail wait ─────────────────────────────────────────────────────────────

function waitForMail(agentName: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const eventName = `mail:${agentName}`;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      mailEvents.removeListener(eventName, onMail);
      signal.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };

    const onMail = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); resolve(); };

    mailEvents.on(eventName, onMail);
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { cleanup(); resolve(); }, 60_000);
  });
}
