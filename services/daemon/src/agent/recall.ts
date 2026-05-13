/**
 * Universal auto-recall wrapping (FIX_FORWARD 2.5).
 *
 * Every prompt the daemon dispatches to the SDK passes through this helper.
 * `safeRecall` is best-effort: a memory-store error never blocks the turn.
 * `wrapWithRecall` is the one-line idiom for dispatch sites — it prepends
 * the `<memory-context>` block when non-empty, returns the body unchanged
 * otherwise.
 *
 * Future-shape note (per FIX_FORWARD 2.5): we may want to filter recall by
 * intent (mail-derived vs user-derived vs scheduled) once a memory MCP
 * supports tag selectors. The wire shape of `<memory-context>` stays
 * uniform; the intent string is captured here as the natural place for a
 * future intent-tag filter to hook in without changing call sites.
 */

import { buildAutoRecallBlock } from "@friday/memory";
import { logger } from "../log.js";

export type RecallIntent =
  | "user_chat"
  | "mail"
  | "scheduled"
  | "scratch"
  | "agent_spawn";

/**
 * Returns the `<memory-context>` block as a string, or "" on any error.
 * The intent argument is unused today (recall is uniform) — it's
 * forward-compat instrumentation for intent-tagged filtering.
 */
export function safeRecall(text: string, intent: RecallIntent = "user_chat"): string {
  try {
    return buildAutoRecallBlock(text);
  } catch (err) {
    logger.log("warn", "memory.recall.error", {
      intent,
      message: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

/**
 * Prepend `<memory-context>` to `body`, using `intentText` to query memory.
 * Pass the user-intent slice (the actual text the user/sender meant) as
 * `intentText`, not the fully-decorated prompt — recall on formatting noise
 * (skill scaffolds, mail-listing prose) pulls in irrelevant memories.
 */
export function wrapWithRecall(
  intentText: string,
  body: string,
  intent: RecallIntent = "user_chat",
): string {
  const block = safeRecall(intentText, intent);
  return block ? `${block}\n\n${body}` : body;
}
