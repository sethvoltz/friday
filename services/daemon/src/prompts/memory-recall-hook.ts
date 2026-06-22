/**
 * FRI-123: `memoryRecallHook` — `before_prompt_build` handler that
 * prepends a `<memory-context>` block onto the per-turn body when FTS
 * recall returns hits.
 *
 * FRI-89 (reversal): this block used to ride `systemPrompt.append`, but
 * the Claude Agent SDK only materializes the append at session-create /
 * compaction re-anchor — never on ordinary resumed turns — so dynamic
 * per-turn recall was frozen-on-resume. It now rides `prependBody` (a
 * fresh user message every turn → resume-proof). See the return statement
 * below and FRI-167 (the sibling datetime fix).
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
      // FRI-141 carve-out keeps "person"; FRI-26 (design D7 / Decision A) adds
      // "archived" so hygiene-archived memories are suppressed from passive
      // auto-recall (searchMemories has no status awareness — it only honors
      // caller-supplied excludeTags, so the archive tag suppresses recall only
      // because this caller passes it).
      excludeTags: ["person", "archived"],
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

/** True for a turn whose body is a native `/compact` slash command. Recall
 *  against the literal "/compact <persona text>" returns garbage, appends a
 *  junk <memory-context> block, does a full listEntries() read, and bumps
 *  recallCount — all pollution on a turn whose only job is to compact. The
 *  `compact` intentTag covers the maintenance-dispatch path that goes through
 *  buildDispatchPrompt with `{kind:'compact'}`; this prefix check additionally
 *  covers a USER-TYPED `/compact` (which arrives as `intentTag:'user_chat'` via
 *  the dispatch-listener / resume-listener — those never construct the compact
 *  kind). `/compact` is not a registered system command, so it falls through to
 *  a normal user_chat dispatch. Leading-whitespace tolerant; matches the bare
 *  command or `/compact <args>`, not an unrelated word like `/compaction`. */
function isCompactCommand(intentText: string): boolean {
  return /^\s*\/compact(\s|$)/.test(intentText);
}

export async function memoryRecallHook(
  ctx: HookContextMap["before_prompt_build"],
): Promise<HookResultMap["before_prompt_build"] | void> {
  // FRI-156 §B: a `/compact …` maintenance turn exists only to compact the
  // session. Skip recall (see isCompactCommand for the pollution rationale) —
  // the /compact turn's system prompt stays the base prompt only. Covers both
  // the `compact` intentTag (maintenance dispatch) and a user-typed `/compact`
  // (arrives as user_chat).
  if (ctx.intentTag === "compact" || isCompactCommand(ctx.intent)) return;
  const block = await safeRecall(ctx.intent, ctx.intentTag);
  if (!block) return;
  // FRI-89 (reversal): ride the per-turn body channel, NOT systemPrompt.append.
  // The SDK only materializes systemPrompt.append at session-create / compaction
  // re-anchor, so dynamic FTS recall computed every turn was frozen-on-resume on
  // exactly the long-lived agents it matters most for. The body is a fresh user
  // message every turn → resume-proof. build-dispatch-prompt.ts:135 already routes
  // prependBody ahead of the user text. (Mirrors FRI-167's datetime body-inject.)
  return { prependBody: block };
}
