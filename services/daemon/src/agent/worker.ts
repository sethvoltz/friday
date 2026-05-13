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
/**
 * Set when a `mail-wakeup-critical` IPC arrives. Read at the next SDK
 * iteration boundary inside `runQuery`; on set, the worker breaks the
 * iterator and lets `mainLoop` drain the inbox (FIX_FORWARD 2.4).
 */
let pendingCriticalMail = false;
/**
 * Set when the parent has queued user prompts and signalled
 * `prompts-pending`. Read at the next SDK iteration boundary; on set, the
 * worker breaks the iterator and emits `turn-complete`. The parent's
 * existing turn-complete handler then pops `nextPrompts` and sends a
 * fresh `prompt` IPC (FIX_FORWARD 2.4).
 */
let promptsPending = false;
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
    } else if (msg.type === "mail-wakeup-critical") {
      mailWakeupPending = true;
      pendingCriticalMail = true;
      wakeIdle();
    } else if (msg.type === "prompts-pending") {
      promptsPending = true;
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
 * `content_block_start/delta/stop` events. We mint a `clientBlockId` that's
 * unique within this worker process (so duplicate indices across messages
 * stay separate) and the daemon correlates start/delta/stop by that id.
 */
interface BlockState {
  clientBlockId: string;
  kind: "text" | "tool_use" | "thinking";
  blockIndex: number;
  messageId?: string;
  /** Stable tool id from the SDK content block; only set when kind === 'tool_use'. */
  toolId?: string;
  toolName?: string;
  /** Accumulated text for text/thinking; assembled for the final block-stop. */
  text: string;
  /** Accumulated `input_json_delta.partial_json` for tool_use blocks. */
  inputJson?: string;
}

function nextClientBlockId(): string {
  return `b_${randomUUID()}`;
}

function finalizeBlockContent(b: BlockState): string {
  if (b.kind === "text") {
    return JSON.stringify({ text: b.text });
  }
  if (b.kind === "thinking") {
    return JSON.stringify({ text: b.text });
  }
  // tool_use
  let input: unknown = {};
  if (b.inputJson && b.inputJson.length > 0) {
    try {
      input = JSON.parse(b.inputJson);
    } catch {
      input = { _raw: b.inputJson };
    }
  }
  return JSON.stringify({
    tool_use_id: b.toolId ?? "",
    name: b.toolName ?? "",
    input,
  });
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
  // Keyed by SDK content-block index *within the current assistant message*.
  // We mint a fresh `clientBlockId` per block-start so the daemon can
  // correlate without relying on the SDK index (which resets each message).
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
            const toolId = cb.id ?? `tool_${e.index}`;
            const state: BlockState = {
              clientBlockId: nextClientBlockId(),
              kind: "tool_use",
              blockIndex: e.index,
              messageId: currentMessageId || undefined,
              toolId,
              toolName: cb.name ?? "",
              text: "",
              inputJson: "",
            };
            blocks.set(e.index, state);
            emit({
              type: "block-start",
              clientBlockId: state.clientBlockId,
              kind: "tool_use",
              blockIndex: e.index,
              messageId: state.messageId,
              tool: { id: toolId, name: state.toolName ?? "" },
            });
          } else if (cb.type === "thinking") {
            const state: BlockState = {
              clientBlockId: nextClientBlockId(),
              kind: "thinking",
              blockIndex: e.index,
              messageId: currentMessageId || undefined,
              text: "",
            };
            blocks.set(e.index, state);
            emit({
              type: "block-start",
              clientBlockId: state.clientBlockId,
              kind: "thinking",
              blockIndex: e.index,
              messageId: state.messageId,
            });
          } else {
            const state: BlockState = {
              clientBlockId: nextClientBlockId(),
              kind: "text",
              blockIndex: e.index,
              messageId: currentMessageId || undefined,
              text: "",
            };
            blocks.set(e.index, state);
            emit({
              type: "block-start",
              clientBlockId: state.clientBlockId,
              kind: "text",
              blockIndex: e.index,
              messageId: state.messageId,
            });
          }
          continue;
        }

        if (e.type === "content_block_delta" && typeof e.index === "number") {
          const block = blocks.get(e.index);
          if (!block) continue;
          const d = e.delta ?? {};
          if (d.type === "text_delta" && typeof d.text === "string" && block.kind === "text") {
            block.text += d.text;
            emit({
              type: "block-delta",
              clientBlockId: block.clientBlockId,
              delta: { text: d.text },
            });
          } else if (
            d.type === "thinking_delta" &&
            typeof d.thinking === "string" &&
            block.kind === "thinking"
          ) {
            block.text += d.thinking;
            emit({
              type: "block-delta",
              clientBlockId: block.clientBlockId,
              delta: { text: d.thinking },
            });
          } else if (
            d.type === "input_json_delta" &&
            typeof d.partial_json === "string" &&
            block.kind === "tool_use"
          ) {
            block.inputJson = (block.inputJson ?? "") + d.partial_json;
            emit({
              type: "block-delta",
              clientBlockId: block.clientBlockId,
              delta: { partial_json: d.partial_json },
            });
          }
          continue;
        }

        if (e.type === "content_block_stop" && typeof e.index === "number") {
          const block = blocks.get(e.index);
          if (!block) continue;
          emit({
            type: "block-stop",
            clientBlockId: block.clientBlockId,
            contentJson: finalizeBlockContent(block),
            status: "complete",
          });
          continue;
        }

        continue;
      }

      if (m.type === "assistant") {
        // FIX_FORWARD 2.4: SDK iteration boundary. Each assistant message
        // marks the end of one model step (tool calls land in the
        // subsequent `user` message). Check whether we have queued user
        // prompts or critical mail to inject — if so, break the iterator
        // gracefully. The parent's turn-complete handler will drain the
        // next prompt; `mainLoop` drains the inbox for critical mail.
        if (promptsPending || pendingCriticalMail) {
          promptsPending = false;
          pendingCriticalMail = false;
          break;
        }
        continue;
      }

      if (m.type === "user") {
        const userMsg = m.message as
          | { id?: string; content?: unknown[] }
          | undefined;
        const content = userMsg?.content;
        if (Array.isArray(content)) {
          content.forEach((rawBlock, idx) => {
            const block = rawBlock as {
              type?: string;
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
            };
            if (block.type === "tool_result" && block.tool_use_id) {
              const clientBlockId = nextClientBlockId();
              const status: "complete" | "error" = block.is_error
                ? "error"
                : "complete";
              const text = stringifyToolResult(block.content);
              emit({
                type: "block-start",
                clientBlockId,
                kind: "tool_result",
                blockIndex: idx,
                messageId: userMsg?.id,
                tool: { id: block.tool_use_id, name: "" },
              });
              emit({
                type: "block-stop",
                clientBlockId,
                contentJson: JSON.stringify({
                  tool_use_id: block.tool_use_id,
                  text,
                  is_error: block.is_error === true,
                }),
                status,
              });
            }
          });
        }
        continue;
      }

      // FIX_FORWARD 1.5 removed the compaction_* wire events; the SDK's
      // `compact_boundary_started/ended` system frames no longer surface as
      // SSE traffic. Compaction stays an invisible runtime concern.
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
