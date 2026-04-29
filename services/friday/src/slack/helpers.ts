import type { SessionType } from "@friday/shared";
import type { RuntimeConfig } from "../config.js";
import { buildAgentSystemPrompt } from "../agent/prime.js";
import type { QueuedMessage, MultimodalPrompt } from "../sessions/queue.js";

export type { MultimodalPrompt };

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

  // Typed sessions (orchestrator, builder, helper) get their role prime
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

You have persistent memory. Relevant memories are automatically injected into your context — they appear in a \`<memory-context>\` block at the top of messages.

**Save reflexively:** After every turn, if you learned a preference, decision, correction, or useful context — save it immediately with \`memory_save\`. Search first to avoid duplicates; use \`memory_update\` to refine existing memories instead of creating near-duplicates.

**Search manually** only when checking for duplicates before saving, or looking up a topic not in the current message.

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
 * Build display text for a batch of messages, substituting "[image]" for
 * messages that have no text (image-only Slack messages).
 */
export function buildBatchDisplayText(messages: QueuedMessage[]): string {
  const texts = messages.map((m) => m.text.trim() || "[image]");
  return buildBatchPrompt(texts);
}

/**
 * Build the prompt content for a batch. Returns a plain string when no
 * message in the batch carries images; returns a MultimodalPrompt when at
 * least one message has images so the caller can pass image content blocks
 * to the agent alongside the text.
 *
 * When any message in the batch is flagged as an interrupt, the prompt is
 * prefixed with an [INTERRUPT] marker so the orchestrator knows to kill
 * active builders before starting new work.
 */
export function buildBatchContent(
  messages: QueuedMessage[]
): string | MultimodalPrompt {
  const allImages = messages.flatMap((m) => m.images ?? []);
  const hasInterrupt = messages.some((m) => m.interrupt);

  const rawText = buildBatchPrompt(messages.map((m) => m.text.trim() || "[image]"));
  const text = hasInterrupt
    ? `[INTERRUPT] The user is redirecting the current task:\n\n${rawText}`
    : rawText;

  if (allImages.length === 0) {
    const textOnly = buildBatchPrompt(messages.map((m) => m.text));
    return hasInterrupt
      ? `[INTERRUPT] The user is redirecting the current task:\n\n${textOnly}`
      : textOnly;
  }

  return { text, images: allImages };
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

// ── Interrupt detection ───────────────────────────────────────────────────

/**
 * Interrupt phrases: patterns that signal the user wants to cancel or redirect
 * an active builder. Evaluated case-insensitively against the full message text.
 *
 * Rules:
 *   - "stop" alone (with optional punctuation) triggers, but "stop by/at/for/in/to/over" does not
 *   - Compound phrases ("no don't", "shoot stop", etc.) trigger on word boundaries
 *   - Messages starting with "!" are unconditional interrupt signals
 */
const INTERRUPT_RE: RegExp[] = [
  /^!/, // "! do this instead"
  /^stop[!.?\s]*$/i, // "stop", "stop!" (lone word only)
  /^no[,\s]+don'?t\b/i, // "no don't", "no, don't"
  /\bshoot[,\s]+stop\b/i, // "shoot stop"
  /^(cancel|abort)([!?.]*\s*$|\s+that\b)/i, // "cancel", "cancel that" — not "cancel order"
  /^(revert|undo)([!?.]*\s*$|\s+that\b)/i, // "revert", "undo" — not "revert merge"
  /^(wait[,\s]+)?no[!?.]*\s*$/i, // "no", "wait no" — not "nobody" or "no problem"
  /^never\s+mind\b/i, // "never mind"
  /^forget\s+that\b/i, // "forget that"
  /^actually\s+(stop|cancel|don'?t|abort)\b/i, // "actually stop/cancel"
];

/** Phrases that look like interrupts but aren't (checked after INTERRUPT_RE). */
const INTERRUPT_FALSE_POSITIVE_RE: RegExp[] = [
  /^stop\s+(by|at|for|in|to|over|it)\b/i, // "stop by", "stop for", "stop it" (context-specific)
];

/**
 * Returns true if the message text matches an interrupt signal pattern.
 * Used to flag Slack messages that should be treated as mid-task redirects.
 */
export function isInterruptSignal(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const matched = INTERRUPT_RE.some((re) => re.test(trimmed));
  if (!matched) return false;

  const falsePositive = INTERRUPT_FALSE_POSITIVE_RE.some((re) => re.test(trimmed));
  return !falsePositive;
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
