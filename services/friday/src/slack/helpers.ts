import type { SessionType } from "@friday/shared";
import type { RuntimeConfig } from "../config.js";
import { buildAgentSystemPrompt } from "../agent/prime.js";

/**
 * Determine the system prompt to pass to the agent SDK.
 * Generates type-appropriate priming for each session type.
 */
export function buildSystemPrompt(
  config: RuntimeConfig,
  sessionType: SessionType,
  channelId: string,
  cwd: string
): { type: "preset"; preset: "claude_code"; append: string } | undefined {
  const isOrchestrator = sessionType === "orchestrator";
  const agentConfig = isOrchestrator ? config.agent : config.independentAgent;
  const customPrompt = agentConfig?.systemPrompt;

  const channelContext = `You are communicating via Slack channel ${channelId}.`;

  // Typed sessions (orchestrator, builder, agent) get their role prime
  if (sessionType !== "bare") {
    const prime = buildAgentSystemPrompt({
      agentName: sessionType === "orchestrator" ? "orchestrator" : `slack-${sessionType}`,
      agentType: sessionType,
      cwd,
    });
    const parts = [channelContext, prime];
    if (customPrompt) parts.push(customPrompt);
    return {
      type: "preset",
      preset: "claude_code",
      append: parts.join("\n\n"),
    };
  }

  // Bare sessions: always include memory guidance + optional custom prompt
  const bareMemoryPrompt = `## Memory

You have persistent memory that survives across sessions. Use it proactively — don't wait to be told.

**Save** (\`memory_save\`) when you learn something worth remembering next time: user preferences, decisions and their reasoning, project context, workflow conventions, corrections to your approach. Search before saving to avoid duplicates.

**Search** (\`memory_search\`) when the user references prior conversations, when starting work on a familiar topic, or when context from previous sessions would help.

Keep memories concise — focus on the *why*, not just the *what*.`;

  const parts = [channelContext, bareMemoryPrompt];
  if (customPrompt) parts.push(customPrompt);

  return {
    type: "preset",
    preset: "claude_code",
    append: parts.join("\n\n"),
  };
}

/**
 * Split a long message into chunks that fit within Slack's character limit.
 * Prefers breaking at newlines, then spaces, then hard-breaks.
 */
export function chunkMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = remaining.lastIndexOf("\n", maxLength);
    if (breakPoint <= 0) {
      breakPoint = remaining.lastIndexOf(" ", maxLength);
    }
    if (breakPoint <= 0) {
      breakPoint = maxLength;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

/**
 * Combine a batch of queued messages into a single prompt string.
 */
export function buildBatchPrompt(texts: string[]): string {
  return texts.length === 1 ? texts[0] : texts.join("\n\n");
}

/**
 * Build a blockquote echo of user messages for display in the placeholder.
 * Returns null if there are no messages to quote.
 */
export function buildBlockquote(texts: string[]): string {
  return texts
    .map((t) =>
      t
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
    )
    .join("\n\n");
}

/**
 * Format an error message for posting to Slack.
 */
export function formatErrorResponse(
  errorMessage: string,
  quoted: string | null
): string {
  if (quoted) {
    return `${quoted}\n\n:radioactive_sign: _${errorMessage}_`;
  }
  return `:radioactive_sign: _${errorMessage}_`;
}

/**
 * Build the slash command response for /friday session.
 */
export function buildSessionFields(
  sessionId: string,
  stats: { turnCount: number; totalCostUsd: number; cacheHitRate: number; firstTurnAt: string; totalDurationMs: number } | null,
  workDir: string,
  formatAge: (iso: string) => string,
  formatDuration: (ms: number) => string
): string[] {
  return [
    `*Session*  \`${sessionId.slice(0, 8)}…\``,
    `*Turns*  ${stats?.turnCount ?? "—"}`,
    `*Cost*  ${stats ? `$${stats.totalCostUsd.toFixed(4)}` : "—"}`,
    `*Cache hit rate*  ${stats ? `${stats.cacheHitRate}%` : "—"}`,
    `*Started*  ${stats ? formatAge(stats.firstTurnAt) : "—"}`,
    `*Agent time*  ${stats ? formatDuration(stats.totalDurationMs) : "—"}`,
    `*Working dir*  \`${workDir}\``,
  ];
}
