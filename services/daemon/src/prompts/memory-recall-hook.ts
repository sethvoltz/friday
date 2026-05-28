/**
 * FRI-123: `memoryRecallHook` — `before_prompt_build` handler that
 * appends a `<memory-context>` block when FTS recall returns hits.
 *
 * Moved from `services/daemon/src/hooks/memory-recall-hook.ts` as
 * part of the prompts/ deepening: the hook is prompt-concern, not
 * generic-hook-concern, and lives next to its callers (the
 * `buildDispatchPrompt` pipeline). `skillContextHook` stays under
 * `hooks/` — it is skill-concern and happens to subscribe to the
 * same event.
 *
 * `safeRecall` (the underlying recall + listener-readiness gate) is
 * folded into this file from the deleted
 * `services/daemon/src/agent/recall.ts` so the prompt-build path
 * owns its own dependency surface. `RecallIntent` is removed as a
 * separate type — the `DispatchIntent['kind']` discriminator in
 * `intent.ts` is the single source of truth, and the hook receives
 * `intentTag` already resolved by the dispatch pipeline.
 */

import { buildAutoRecallBlock } from "@friday/memory";
import type { HookContextMap, HookResultMap } from "@friday/shared";
import { logger } from "../log.js";
import { whenMemoryListenerReady } from "../memory/listener.js";

const LISTENER_READY_TIMEOUT_MS = 3_000;

type IntentTag = HookContextMap["before_prompt_build"]["intentTag"];

/**
 * Returns the `<memory-context>` block as a string, or "" on any
 * error. Gates on the memory listener being ready (max 3 s); if the
 * listener hasn't finished its LISTEN setup within the timeout,
 * recall is skipped (fail-open) and the caller proceeds without a
 * memory block.
 *
 * Exported for the existing `recall.test.ts` listener-ready gate
 * suite, which pins the timeout / fail-open semantics independently
 * of the hook composition.
 */
export async function safeRecall(text: string, intent: IntentTag = "user_chat"): Promise<string> {
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

export async function memoryRecallHook(
  ctx: HookContextMap["before_prompt_build"],
): Promise<HookResultMap["before_prompt_build"] | void> {
  const block = await safeRecall(ctx.intent, ctx.intentTag);
  if (!block) return;
  return { appendSystemPrompt: block };
}
