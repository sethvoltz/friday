/**
 * One-shot Claude SDK wrapper used by the enrichment pass. No tools, no MCP
 * — purely an authenticated text-generation call. Keeps Pro/Max billing.
 *
 * Ported verbatim from old SlackAgents Friday.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

export type AbortReason = "timeout" | "interrupted" | "api-error" | "unknown";

export class ChatAbortError extends Error {
  readonly reason: AbortReason;
  constructor(reason: AbortReason, message: string) {
    super(message);
    this.name = "ChatAbortError";
    this.reason = reason;
  }
}

export interface ChatOptions {
  prompt: string;
  systemPrompt: string;
  model: string;
  /** Abort after this many ms — defends against hung SDK queries. Default 60s. */
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  costUsd: number | null;
  durationMs: number;
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeoutMs);

  const queryOptions: Record<string, unknown> = {
    allowedTools: [],
    model: opts.model,
    permissionMode: "bypassPermissions",
    abortController: abort,
    systemPrompt: opts.systemPrompt,
  };

  let text = "";
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let costUsd: number | null = null;

  try {
    for await (const message of query({
      prompt: opts.prompt,
      options: queryOptions,
    })) {
      if (message.type === "assistant") {
        const content = (message as { message?: { content?: unknown } }).message
          ?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block &&
              typeof block === "object" &&
              "type" in block &&
              (block as { type: string }).type === "text" &&
              typeof (block as { text?: string }).text === "string"
            ) {
              text += (block as { text: string }).text;
            }
          }
        }
      } else if (message.type === "result") {
        const m = message as {
          subtype?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          total_cost_usd?: number | null;
        };
        if (m.usage) {
          usage = {
            inputTokens: m.usage.input_tokens ?? 0,
            outputTokens: m.usage.output_tokens ?? 0,
            cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: m.usage.cache_creation_input_tokens ?? 0,
          };
        }
        if (typeof m.total_cost_usd === "number") costUsd = m.total_cost_usd;
      }
    }
  } catch (err) {
    const isAbortLike =
      err instanceof Error &&
      (err.name === "AbortError" ||
        err.message.toLowerCase().includes("aborted") ||
        err.message.toLowerCase().includes("abort"));

    if (isAbortLike) {
      if (timedOut) {
        throw new ChatAbortError(
          "timeout",
          `enrichment timed out after ${timeoutMs / 1000}s`,
        );
      }
      throw new ChatAbortError(
        "interrupted",
        "enrichment aborted (SIGINT or parent session lifecycle)",
      );
    }

    const msg = err instanceof Error ? err.message : String(err);
    throw new ChatAbortError("api-error", `enrichment API error: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  if (!text.trim()) {
    throw new Error("LLM returned no text content");
  }

  return {
    text: text.trim(),
    usage,
    costUsd,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Extract a JSON object from a chat reply. Strips ```json fences and tolerates
 * surrounding prose. Throws with the raw text on failure.
 */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate) as T;
  } catch {
    // Fall through to bracket-balanced extraction.
  }

  const start = candidate.indexOf("{");
  if (start === -1) {
    throw new Error(`No JSON object found in LLM reply:\n${text}`);
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice) as T;
        } catch (err) {
          throw new Error(
            `Failed to parse JSON from LLM reply: ${(err as Error).message}\nRaw:\n${text}`,
          );
        }
      }
    }
  }
  throw new Error(`Unterminated JSON object in LLM reply:\n${text}`);
}
