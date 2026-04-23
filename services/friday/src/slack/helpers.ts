import type { RuntimeConfig } from "../config.js";

/**
 * Determine the system prompt to pass to the agent SDK.
 */
export function buildSystemPrompt(
  config: RuntimeConfig,
  isOrchestrator: boolean,
  channelId: string
): string | { type: "preset"; preset: "claude_code"; append: string } | undefined {
  const agentConfig = isOrchestrator ? config.agent : config.independentAgent;
  const customPrompt = agentConfig?.systemPrompt;

  const channelContext = `You are communicating via Slack channel ${channelId}.`;

  if (customPrompt) {
    return {
      type: "preset",
      preset: "claude_code",
      append: `${channelContext}\n\n${customPrompt}`,
    };
  }

  if (isOrchestrator) {
    return {
      type: "preset",
      preset: "claude_code",
      append: channelContext,
    };
  }

  return undefined;
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
