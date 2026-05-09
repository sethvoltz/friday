/**
 * Worker entrypoint. Forked by `lifecycle.ts`. Speaks the protocol defined in
 * `worker-protocol.ts`. Hosts a long-lived agent loop:
 *
 *   while (!stopped) {
 *     if pendingPrompt → run query() with that prompt
 *     else drain mail inbox; if mail → build mail prompt → run query()
 *     else emit idle, await mail-wakeup / new prompt / stop / 60s timeout
 *   }
 *
 * `mode === "one-shot"` short-circuits the loop after the first query() —
 * scheduled agents fire, run, and exit.
 *
 * MCP servers are reconstructed inside the worker (their config carries a
 * live McpServer instance that can't cross the IPC boundary).
 */

import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { stringifyToolResult } from "@friday/shared";
import type { MailRow } from "@friday/shared/services";
import type {
  WorkerCommand,
  WorkerEvent,
  WorkerPromptCommand,
  WorkerSpawnOptions,
} from "./worker-protocol.js";
import { buildMcpServers } from "../mcp/builder.js";
import { buildMailPrompt } from "../comms/mail-prompt.js";
import { daemonFetch } from "../mcp/http.js";
import { checkToolCall } from "./workspace-guard.js";

let abortController: AbortController | null = null;
let stopped = false;
let mainLoopRunning = false;
let pendingPrompt: WorkerPromptCommand | null = null;
let mailWakeupPending = false;
let idleResolve: (() => void) | null = null;
let workerOpts: WorkerSpawnOptions | null = null;
let lastSessionId: string | undefined;

function emit(e: WorkerEvent): void {
  if (process.send) process.send(e);
}

function wakeIdle(): void {
  if (idleResolve) {
    const r = idleResolve;
    idleResolve = null;
    r();
  }
}

process.on("message", (msg: WorkerCommand) => {
  try {
    if (msg.type === "start") {
      if (!workerOpts) {
        workerOpts = msg.options;
        lastSessionId = msg.options.resumeSessionId;
        pendingPrompt = {
          prompt: msg.options.prompt,
          turnId: msg.options.turnId,
          resumeSessionId: msg.options.resumeSessionId,
          allowedToolsOverride: msg.options.allowedToolsOverride,
        };
        if (!mainLoopRunning) {
          mainLoopRunning = true;
          void mainLoop();
        }
      }
    } else if (msg.type === "prompt") {
      // Replace any unprocessed pending prompt — the latest user input wins.
      pendingPrompt = msg.options;
      wakeIdle();
    } else if (msg.type === "abort") {
      abortController?.abort();
    } else if (msg.type === "stop") {
      stopped = true;
      abortController?.abort();
      wakeIdle();
    } else if (msg.type === "mail-wakeup") {
      mailWakeupPending = true;
      wakeIdle();
    }
  } catch (err: unknown) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
  }
});

emit({ type: "ready" });

async function mainLoop(): Promise<void> {
  if (!workerOpts) return;
  try {
    while (!stopped) {
      if (pendingPrompt) {
        const p = pendingPrompt;
        pendingPrompt = null;
        await runQuery(p);
        if (workerOpts.mode === "one-shot") break;
        continue;
      }

      // Long-lived path: check inbox before idling.
      mailWakeupPending = false;
      const inbox = await fetchInboxQuiet(
        workerOpts.agentName,
        workerOpts.daemonPort,
      );
      if (inbox.length > 0) {
        pendingPrompt = {
          prompt: buildMailPrompt(workerOpts.agentName, inbox),
          turnId: `t_${randomUUID()}`,
          resumeSessionId: lastSessionId,
        };
        continue;
      }

      // Idle. Resolved by mail-wakeup, prompt, stop, or 60s timeout (which
      // re-checks the inbox as a backstop in case the IPC was missed).
      emit({ type: "status-change", status: "idle" });
      await new Promise<void>((resolve) => {
        idleResolve = resolve;
        setTimeout(() => {
          if (idleResolve === resolve) {
            idleResolve = null;
            resolve();
          }
        }, 60_000).unref();
      });
    }
  } catch (err: unknown) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
  } finally {
    process.exit(0);
  }
}

async function fetchInboxQuiet(
  agentName: string,
  port: number,
): Promise<MailRow[]> {
  try {
    return await daemonFetch<MailRow[]>({
      port,
      path: `/api/mail/inbox/${encodeURIComponent(agentName)}`,
      callerName: agentName,
    });
  } catch {
    return [];
  }
}

/**
 * Per-turn block tracking. The SDK gives us `index` for content blocks inside
 * `content_block_start/delta/stop` events (not stable ids). For tool_use we
 * have a real id from the block; for thinking we synthesize a stable block id
 * from the message id + content index.
 */
interface BlockState {
  kind: "text" | "tool_use" | "thinking";
  /** Stable id surfaced to consumers (block.id for tool_use, synthesized for thinking). */
  emittedId?: string;
  /** Cached tool name for tool-end emission. */
  toolName?: string;
  /** Accumulated `input_json_delta.partial_json` for tool_use blocks; parsed on stop. */
  inputJson?: string;
}

async function runQuery(p: WorkerPromptCommand): Promise<void> {
  if (!workerOpts) return;
  const opts = workerOpts;

  abortController = new AbortController();
  emit({ type: "status-change", status: "working" });

  // Periodic heartbeat so the parent's stall watchdog can distinguish a
  // mid-tool wait from a frozen worker. Every event already updates the
  // parent's lastHeartbeat — this just covers gaps when the SDK is between
  // tool turns and not streaming text.
  const hbInterval = setInterval(() => {
    emit({ type: "heartbeat" });
  }, 10_000);
  hbInterval.unref();

  let sessionId = p.resumeSessionId ?? lastSessionId;
  let sessionAnnounced = false;
  let currentMessageId = "";
  const blocks = new Map<number, BlockState>();

  const DEFAULT_THINKING_BUDGET = 8192;
  const thinking =
    opts.thinking?.type === "enabled"
      ? {
          type: "enabled" as const,
          budgetTokens: opts.thinking.budgetTokens ?? DEFAULT_THINKING_BUDGET,
        }
      : opts.thinking;

  const mcpServers = buildMcpServers({
    callerType: opts.agentType,
    callerName: opts.agentName,
    daemonPort: opts.daemonPort,
    parentName: opts.parentName,
  });

  const allowedTools = p.allowedToolsOverride ?? opts.allowedToolsOverride;

  // Defense-in-depth: builders run inside a git worktree, and the Claude SDK
  // PreToolUse hook denies any Read/Write/Edit/Glob/Grep/Bash that escapes it.
  // The system prompt also tells the builder this; the hook is the enforcement
  // layer for when the prompt isn't enough.
  const builderGuardHooks =
    opts.agentType === "builder"
      ? {
          PreToolUse: [
            {
              hooks: [
                async (input: unknown) => {
                  const i = input as {
                    hook_event_name?: string;
                    tool_name?: string;
                    tool_input?: Record<string, unknown>;
                  };
                  if (i.hook_event_name !== "PreToolUse") return {};
                  const reason = checkToolCall(
                    opts.workingDirectory,
                    i.tool_name,
                    (i.tool_input ?? {}) as Record<string, unknown>,
                  );
                  if (reason) {
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse" as const,
                        permissionDecision: "deny" as const,
                        permissionDecisionReason: reason,
                      },
                    };
                  }
                  return {};
                },
              ],
            },
          ],
        }
      : undefined;

  try {
    for await (const msg of query({
      prompt: p.prompt,
      options: {
        cwd: opts.workingDirectory,
        model: opts.model,
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
        mcpServers,
        // Friday owns memory via friday-memory MCP. Disabling the SDK's
        // project-scoped auto-memory prevents the model from silently
        // falling back to writes under ~/.claude/projects/<cwd>/memory/.
        // `autoMemoryEnabled` lives on Settings, passed through the
        // top-level `settings` Options field.
        settings: { autoMemoryEnabled: false },
        ...(builderGuardHooks ? { hooks: builderGuardHooks } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(thinking ? { thinking } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        systemPrompt: opts.systemPrompt
          ? { type: "preset", preset: "claude_code", append: opts.systemPrompt }
          : undefined,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })) {
      const m = msg as Record<string, unknown>;

      const maybeSession = m.session_id as string | undefined;
      if (maybeSession) {
        sessionId = maybeSession;
        if (!sessionAnnounced) {
          emit({ type: "session-update", sessionId: maybeSession });
          sessionAnnounced = true;
        }
      }

      // Drop SDK Task sub-agent traffic. Their stream/assistant/user messages
      // carry `parent_tool_use_id` set to the spawning Task's tool_use id;
      // emitting them would tag sub-agent tool blocks with the orchestrator's
      // agent + turn_id and bleed them into the parent's chat.
      if (typeof m.parent_tool_use_id === "string" && m.parent_tool_use_id) {
        continue;
      }

      if (m.type === "stream_event") {
        const e = (m.event ?? {}) as {
          type?: string;
          index?: number;
          content_block?: { type?: string; id?: string; name?: string };
          delta?: {
            type?: string;
            text?: string;
            thinking?: string;
            partial_json?: string;
          };
          message?: { id?: string };
        };

        if (e.type === "message_start" && e.message?.id) {
          currentMessageId = e.message.id;
        }

        if (e.type === "content_block_start" && typeof e.index === "number") {
          const cb = e.content_block ?? {};
          if (cb.type === "tool_use") {
            const id = cb.id ?? `tool_${e.index}`;
            blocks.set(e.index, {
              kind: "tool_use",
              emittedId: id,
              toolName: cb.name ?? "",
            });
            emit({
              type: "tool-start",
              toolId: id,
              toolName: cb.name ?? "",
              input: {},
            });
          } else if (cb.type === "thinking") {
            const id = `${currentMessageId}_${e.index}`;
            blocks.set(e.index, { kind: "thinking", emittedId: id });
            emit({ type: "thinking-start", blockId: id });
          } else {
            blocks.set(e.index, { kind: "text" });
          }
          continue;
        }

        if (e.type === "content_block_delta" && typeof e.index === "number") {
          const block = blocks.get(e.index);
          const d = e.delta ?? {};
          if (d.type === "text_delta" && typeof d.text === "string") {
            emit({
              type: "text-delta",
              text: d.text,
              messageId: currentMessageId || undefined,
            });
          } else if (
            d.type === "thinking_delta" &&
            typeof d.thinking === "string" &&
            block?.kind === "thinking" &&
            block.emittedId
          ) {
            emit({
              type: "thinking-delta",
              blockId: block.emittedId,
              text: d.thinking,
            });
          } else if (
            d.type === "input_json_delta" &&
            typeof d.partial_json === "string" &&
            block?.kind === "tool_use"
          ) {
            block.inputJson = (block.inputJson ?? "") + d.partial_json;
          }
          continue;
        }

        if (e.type === "content_block_stop" && typeof e.index === "number") {
          const block = blocks.get(e.index);
          if (block?.kind === "thinking" && block.emittedId) {
            emit({ type: "thinking-end", blockId: block.emittedId });
          }
          if (block?.kind === "tool_use" && block.emittedId && block.inputJson) {
            try {
              const parsed = JSON.parse(block.inputJson);
              emit({
                type: "tool-input",
                toolId: block.emittedId,
                input: parsed,
              });
            } catch {
              emit({
                type: "tool-input",
                toolId: block.emittedId,
                input: { _raw: block.inputJson },
              });
            }
          }
          continue;
        }

        continue;
      }

      if (m.type === "assistant") continue;

      if (m.type === "user") {
        const content = (m.message as { content?: unknown[] } | undefined)
          ?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<{
            type?: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          }>) {
            if (block.type === "tool_result" && block.tool_use_id) {
              let toolName = "";
              for (const b of blocks.values()) {
                if (b.emittedId === block.tool_use_id) {
                  toolName = b.toolName ?? "";
                  break;
                }
              }
              emit({
                type: "tool-end",
                toolId: block.tool_use_id,
                toolName,
                status: block.is_error ? "error" : "ok",
                output: stringifyToolResult(block.content),
              });
            }
          }
        }
        continue;
      }

      const subtype = m.subtype as string | undefined;
      if (m.type === "system" && subtype === "compact_boundary_started") {
        emit({ type: "compaction-start" });
      }
      if (m.type === "system" && subtype === "compact_boundary_ended") {
        emit({ type: "compaction-end", result: "success" });
      }
    }

    lastSessionId = sessionId ?? lastSessionId;
    emit({ type: "turn-complete", sessionId: sessionId ?? "" });
    emit({ type: "status-change", status: "idle" });
  } catch (err: unknown) {
    if (abortController.signal.aborted) {
      emit({ type: "error", message: "aborted", recoverable: true });
    } else {
      emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      });
    }
    emit({ type: "status-change", status: "idle" });
  } finally {
    clearInterval(hbInterval);
    abortController = null;
  }
}
