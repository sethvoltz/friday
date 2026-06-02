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

import { buildAutoRecallBlock, listEntries, type MemoryEntry } from "@friday/memory";
import type { HookContextMap, HookResultMap } from "@friday/shared";
import { logger } from "../log.js";
import { whenMemoryListenerReady } from "../memory/listener.js";

const LISTENER_READY_TIMEOUT_MS = 3_000;

type IntentTag = HookContextMap["before_prompt_build"]["intentTag"];

// FRI-141: name-mention carve-out. Person entries are excluded from passive
// auto-recall by default; when the turn text mentions a known person by name
// (natural-language match against the name part of a person:<name> tag), return
// that person tag so the ranker re-admits ONLY their entries. Tokenises text the
// same way the ranker does (search.ts): lowercase, split on whitespace. Matching
// is on dash-separated name SEGMENTS, case-insensitive, EXACT token equality
// (NOT a substring, NOT fuzzy, NOT a nickname table — out of scope).
export function computePersonAllowTags(text: string, entries: MemoryEntry[]): string[] {
  const turnTokens = new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
  const matched = new Set<string>();
  for (const entry of entries) {
    if (!entry.tags.includes("person")) continue;
    for (const tag of entry.tags) {
      const m = /^person:(.+)$/.exec(tag);
      if (!m) continue;
      const segments = m[1].toLowerCase().split("-").filter(Boolean);
      if (segments.some((seg) => turnTokens.has(seg))) matched.add(tag);
    }
  }
  return [...matched];
}

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
    // One full-table read serves both the name-match carve-out and the ranker:
    // thread the loaded entries through as `preloadedEntries` so passive recall
    // does a single listEntries() per turn instead of two.
    const entries = await listEntries();
    const allowTags = computePersonAllowTags(text, entries);
    return await buildAutoRecallBlock(text, {
      excludeTags: ["person"],
      allowTags,
      preloadedEntries: entries,
    });
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
