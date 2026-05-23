import { buildAutoRecallBlock } from "@friday/memory";
import { logger } from "../log.js";

export type RecallIntent = "user_chat" | "mail" | "scheduled" | "scratch" | "agent_spawn";

/**
 * Returns the `<memory-context>` block as a string, or "" on any error.
 * Consumed by the `before_prompt_build` memory-recall hook.
 */
export async function safeRecall(
  text: string,
  intent: RecallIntent = "user_chat",
): Promise<string> {
  try {
    return await buildAutoRecallBlock(text);
  } catch (err) {
    logger.log("warn", "memory.recall.error", {
      intent,
      message: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}
