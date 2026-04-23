import { query } from "@anthropic-ai/claude-agent-sdk";
import { getSessionId, setSessionId } from "../sessions/manager.js";
import { logUsage } from "../monitor/usage.js";

export interface AgentOptions {
  channelId: string;
  isOrchestrator: boolean;
  workingDirectory: string;
  allowedTools: string[];
  model: string;
}

// Track turn count per session for usage logging
const turnCounts = new Map<string, number>();

export interface AgentCallbacks {
  onChunk?: (text: string) => void;
  onCompactStart?: () => void;
  onCompactEnd?: (result: "success" | "failed") => void;
}

/**
 * Send a prompt to the agent and stream text chunks as they arrive.
 * onChunk is called with each new piece of text.
 * Returns the full accumulated response.
 */
export async function sendToAgent(
  prompt: string,
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

  // Resume existing session for this channel, or start fresh
  const existingSessionId = getSessionId(options.channelId);

  const queryOptions: Record<string, any> = {
    allowedTools: options.allowedTools,
    cwd: options.workingDirectory,
    model: options.model,
    permissionMode: "bypassPermissions",
  };

  if (existingSessionId) {
    queryOptions.resume = existingSessionId;
  }

  for await (const message of query({
    prompt,
    options: queryOptions,
  })) {
    if (message.type === "assistant") {
      const text = message.message.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("");
      responseText += text;
      if (text && callbacks.onChunk) {
        callbacks.onChunk(text);
      }
    }

    // Detect compaction status changes
    if (
      message.type === "system" &&
      (message as any).subtype === "status"
    ) {
      const status = (message as any).status;
      const compactResult = (message as any).compact_result;

      if (status === "compacting" && callbacks.onCompactStart) {
        callbacks.onCompactStart();
      }
      if (compactResult && callbacks.onCompactEnd) {
        callbacks.onCompactEnd(compactResult);
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

      // Log to stdout
      console.log(
        JSON.stringify({
          event: "agent_response",
          channelId: options.channelId,
          sessionType: options.isOrchestrator
            ? "orchestrator"
            : "independent",
          sessionId,
          turnNumber,
          costUsd,
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          durationMs,
        })
      );

      // Append to usage log file
      logUsage({
        timestamp: new Date().toISOString(),
        channelId: options.channelId,
        sessionType: options.isOrchestrator
          ? "orchestrator"
          : "independent",
        sessionId,
        costUsd,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        turnNumber,
        durationMs,
      });
    }
  }

  return responseText || "(No response from agent)";
}
