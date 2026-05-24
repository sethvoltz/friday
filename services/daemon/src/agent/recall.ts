import { buildAutoRecallBlock } from "@friday/memory";
import { logger } from "../log.js";
import { whenMemoryListenerReady } from "../memory/listener.js";

export type RecallIntent = "user_chat" | "mail" | "scheduled" | "scratch" | "agent_spawn";

const LISTENER_READY_TIMEOUT_MS = 3_000;

/**
 * Returns the `<memory-context>` block as a string, or "" on any error.
 * Consumed by the `before_prompt_build` memory-recall hook.
 *
 * Gates on the memory listener being ready (max 3 s). If the listener
 * hasn't finished its LISTEN setup within the timeout, recall is
 * skipped and the caller proceeds without a memory block (fail-open).
 */
export async function safeRecall(
  text: string,
  intent: RecallIntent = "user_chat",
): Promise<string> {
  try {
    const isReady = await Promise.race([
      whenMemoryListenerReady().then(() => true as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), LISTENER_READY_TIMEOUT_MS)),
    ]);
    if (!isReady) {
      logger.log("warn", "memory.recall.listener-timeout", { intent });
      return "";
    }
    return await buildAutoRecallBlock(text);
  } catch (err) {
    logger.log("warn", "memory.recall.error", {
      intent,
      message: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}
