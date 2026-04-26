import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionType } from "@friday/shared";
import { getSessionId, setSessionId } from "../sessions/manager.js";
import { logUsage } from "../monitor/usage.js";
import { log } from "../log.js";
import { eventBus } from "../events/bus.js";
import type { MultimodalPrompt } from "../sessions/queue.js";

export interface AgentOptions {
  channelId: string;
  sessionType: SessionType;
  workingDirectory: string;
  allowedTools: string[];
  model: string;
  thinkingIndicatorDelaySec?: number;
  mcpServers?: Record<string, any>;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
}

// Track turn count per session for usage logging
const turnCounts = new Map<string, number>();

export interface AgentCallbacks {
  onChunk?: (text: string) => void;
  onCompactStart?: () => void;
  onCompactEnd?: (result: "success" | "failed") => void;
  onThinkingStart?: (elapsedSec: number) => void;
  onThinkingTick?: (elapsedSec: number) => void;
  onThinkingEnd?: () => void;
  onToolUse?: (toolName: string) => void;
}

async function* multimodalStream(mp: MultimodalPrompt): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: [
        ...mp.images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mediaType as any,
            data: img.data,
          },
        })),
        { type: "text" as const, text: mp.text },
      ],
    },
    parent_tool_use_id: null,
  };
}

/**
 * Send a prompt to the agent and stream text chunks as they arrive.
 * Accepts a plain string or a MultimodalPrompt (text + images).
 * onChunk is called with each new piece of text.
 * Returns the full accumulated response.
 */
export async function sendToAgent(
  prompt: string | MultimodalPrompt,
  options: AgentOptions,
  callbacksOrOnChunk?: AgentCallbacks | ((text: string) => void)
): Promise<string> {
  // Support both old (onChunk function) and new (callbacks object) signatures
  const callbacks: AgentCallbacks =
    typeof callbacksOrOnChunk === "function"
      ? { onChunk: callbacksOrOnChunk }
      : callbacksOrOnChunk ?? {};
  let responseText = "";
  const startTime = Date.now();
  let lastStreamEventAt = 0;
  const STREAM_THROTTLE_MS = 1000;
  // Determine agent name for events: orchestrator session type → "orchestrator", else channelId
  const eventAgentName = options.sessionType === "orchestrator" ? "orchestrator" : options.channelId;

  // Thinking indicator timer — fires after thinkingDelaySec, ticks on each interval
  const thinkingDelaySec = options.thinkingIndicatorDelaySec ?? 30;
  const thinkingDelayMs = thinkingDelaySec * 1000;
  let thinkingTimer: ReturnType<typeof setInterval> | null = null;
  let thinkingStarted = false;
  let thinkingPaused = false;
  let contentReceived = false;

  function clearThinkingTimer() {
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
    if (thinkingStarted && !contentReceived) {
      contentReceived = true;
      callbacks.onThinkingEnd?.();
    }
  }

  if (callbacks.onThinkingStart) {
    thinkingTimer = setInterval(() => {
      if (thinkingPaused || contentReceived) return;
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      if (!thinkingStarted) {
        thinkingStarted = true;
        callbacks.onThinkingStart!(elapsedSec);
      } else {
        callbacks.onThinkingTick?.(elapsedSec);
      }
    }, thinkingDelayMs);
  }

  // Resume existing session for this channel, or start fresh
  const existingSessionId = getSessionId(options.channelId);

  const queryOptions: Record<string, any> = {
    allowedTools: options.allowedTools,
    cwd: options.workingDirectory,
    model: options.model,
    permissionMode: "bypassPermissions",
  };

  if (options.mcpServers) {
    queryOptions.mcpServers = options.mcpServers;
  }

  if (options.systemPrompt) {
    queryOptions.systemPrompt = options.systemPrompt;
  }

  if (existingSessionId) {
    queryOptions.resume = existingSessionId;
  }

  const queryPrompt =
    typeof prompt === "string" ? prompt : multimodalStream(prompt);

  try {
    for await (const message of query({
      prompt: queryPrompt,
      options: queryOptions,
    })) {
      if (message.type === "assistant") {
        const text = message.message.content
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text)
          .join("");
        // Separate consecutive assistant turns with newlines so they
        // don't run together ("...main.Good —" → "...main.\n\nGood —")
        if (text && responseText.length > 0) {
          responseText += "\n\n";
        }
        responseText += text;
        if (text) {
          // First real content — clear thinking indicator
          if (!contentReceived) {
            contentReceived = true;
            if (thinkingStarted) {
              callbacks.onThinkingEnd?.();
            }
            clearThinkingTimer();
          }
          callbacks.onChunk?.(text);
          // Throttled streaming event for dashboard
          const now = Date.now();
          if (now - lastStreamEventAt >= STREAM_THROTTLE_MS) {
            lastStreamEventAt = now;
            const sessionId = existingSessionId ?? "";
            eventBus.publish({ type: "turn:streaming", agentName: eventAgentName, sessionId, text: responseText });
          }
        }
      }

      // Detect tool invocations
      if (message.type === "tool_progress") {
        callbacks.onToolUse?.((message as any).tool_name);
      }

      // Detect compaction status changes — pause thinking during compaction
      if (
        message.type === "system" &&
        (message as any).subtype === "status"
      ) {
        const status = (message as any).status;
        const compactResult = (message as any).compact_result;

        if (status === "compacting") {
          thinkingPaused = true;
          callbacks.onCompactStart?.();
        }
        if (compactResult) {
          thinkingPaused = false;
          callbacks.onCompactEnd?.(compactResult);
        }
      }

      if (message.type === "result") {
        if (message.subtype !== "success") {
          throw new Error(`Agent ended with status: ${message.subtype}`);
        }

        const sessionId = message.session_id;
        setSessionId(options.channelId, sessionId);

        // Track turn number
        const turnNumber = (turnCounts.get(sessionId) ?? 0) + 1;
        turnCounts.set(sessionId, turnNumber);

        const usage = (message as any).usage;
        const costUsd = (message as any).total_cost_usd ?? null;
        const durationMs = Date.now() - startTime;

        const inputTokens = usage?.input_tokens ?? 0;
        const outputTokens = usage?.output_tokens ?? 0;
        const cacheCreationTokens =
          usage?.cache_creation_input_tokens ?? 0;
        const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;

        log("info", "agent_response", {
          channelId: options.channelId,
          sessionType: options.sessionType,
          sessionId,
          turnNumber,
          costUsd,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          durationMs,
        });

        // Append to usage log file
        logUsage({
          timestamp: new Date().toISOString(),
          channelId: options.channelId,
          sessionType: options.sessionType,
          sessionId,
          model: options.model,
          costUsd,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          turnNumber,
          durationMs,
        });

        eventBus.publish({ type: "turn:complete", agentName: eventAgentName, sessionId });
      }
    }
  } finally {
    clearThinkingTimer();
  }

  return responseText;
}
