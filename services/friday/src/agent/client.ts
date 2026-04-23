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

export async function sendToAgent(
  prompt: string,
  options: AgentOptions
): Promise<string> {
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
