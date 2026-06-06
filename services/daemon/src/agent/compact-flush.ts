/**
 * FRI-27 — Compaction-triggered memory flush.
 *
 * When the SDK is about to compact a worker's session (PreCompact hook), this
 * module runs a SHORT, isolated sub-query that gives the model one last chance
 * to save context that summarisation would otherwise lose. It is wired from
 * `worker.ts` as the `PreCompact` hook callback (gated off `builder` agents —
 * builders get read-only memory, so `memory_save` would error).
 *
 * Design (see .plan/OVERRIDES.md #1 + FRI-27):
 *
 *   - The flush sees the FULL pre-compaction conversation via
 *     `resume: <sessionId>` + `forkSession: true`. forkSession means the
 *     resumed session forks to a NEW session id rather than continuing the
 *     original — so the flush's turns NEVER pollute the user transcript, and
 *     the flush's own query registers NO hooks, so it cannot recursively
 *     re-fire PreCompact. (Options.forkSession verified at sdk.d.ts:1278.)
 *   - `autoCompactWindow: 1_000_000` guarantees the flush itself never
 *     compacts; `maxTurns` caps the work; the 30s matcher timeout (set on the
 *     hook in worker.ts, in SECONDS) bounds wall-clock — a stalled flush is
 *     aborted and compaction proceeds. Losing the flush is strictly better
 *     than blocking compaction.
 *   - `allowedTools` is restricted to EXACTLY the three memory tools
 *     (search / get / save); no Bash, no filesystem, no Task. A flush APPENDS
 *     new memory (search-before-save is the store's own dedup discipline); it
 *     must not mutate or delete existing entries, so `memory_update` /
 *     `memory_forget` are omitted.
 *   - The flush prompt is templated with the existing memory INDEX (title +
 *     tags only, to bound the flush's own token budget) so the model can
 *     dedup against what's already saved. The prompt is INDEPENDENT of
 *     FRI-156's persona `custom_instructions` — the two tickets stay
 *     decoupled (the flush never reads `custom_instructions`).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { daemonFetch } from "../mcp/http.js";
import type { WorkerEvent, WorkerSpawnOptions } from "./worker-protocol.js";

type QueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;
type FlushMcpServers = QueryOptions["mcpServers"];

/** The three friday-memory MCP tools the flush is allowed to call. Exactly
 *  these — search + get to dedup, save to append. No update/forget (a flush
 *  never mutates or deletes existing memory). Pinned by worker.test.ts. */
export const FLUSH_ALLOWED_TOOLS = [
  "mcp__friday-memory__memory_search",
  "mcp__friday-memory__memory_get",
  "mcp__friday-memory__memory_save",
] as const;

/** The memory_save tool name we count `tool_use` frames for to report
 *  `savedCount`. */
const MEMORY_SAVE_TOOL = "mcp__friday-memory__memory_save";

/** Disable-value for the flush's own autoCompactWindow — large enough that
 *  the flush sub-query can never itself trigger compaction. */
const FLUSH_AUTO_COMPACT_WINDOW = 1_000_000;

/** Turn cap for the flush sub-query. A handful of search/get/save round-trips
 *  is plenty; capping bounds a pathological flush. */
const FLUSH_MAX_TURNS = 6;

/**
 * The tight, single-paragraph system-prompt append for the flush sub-query.
 *
 * Independent of FRI-156's COMPACT_CUSTOM_INSTRUCTIONS wording by design — the
 * flush's ONLY dynamic input is the templated memory index (added to the
 * prompt string, not here), never `custom_instructions`. Asserted via
 * `.toContain()` pins in worker.test.ts (no golden — single internal consumer).
 */
export const COMPACT_FLUSH_SYSTEM_PROMPT =
  "This session is about to be compacted. Below is the existing memory index " +
  "(a list of [title — tags]). Identify 0–5 pieces of context (decisions, user " +
  "preferences, project facts, lessons) that would be lost to summarization and " +
  "are not already in memory. For each, emit a memory_save call with a title, " +
  "content, and tags. Search first to avoid near-duplicates. If nothing " +
  "qualifies, save nothing — false positives degrade recall.";

/**
 * Build the SDK `query()` options for the PreCompact memory flush. PURE +
 * exported so worker.test.ts can pin the load-bearing invariants without
 * running a query: `resume` + `forkSession` BOTH set (the flush sees the
 * conversation, forked off the user transcript), `allowedTools` exactly the
 * three memory tools, `disallowedTools` includes 'Task', and
 * `autoCompactWindow` is the large disable value.
 *
 * `sessionId` is the about-to-be-compacted session from `PreCompactHookInput`
 * (resolved by the worker). forkSession requires resume (sdk.d.ts:1278), so
 * both are always set together.
 */
export function buildFlushQueryOptions(
  opts: WorkerSpawnOptions,
  sessionId: string,
  mcpServers: FlushMcpServers,
): QueryOptions {
  return {
    cwd: opts.workingDirectory,
    model: opts.model,
    permissionMode: "bypassPermissions",
    mcpServers,
    // No Task sub-agent, and exactly the three memory tools — nothing else.
    disallowedTools: ["Task"],
    allowedTools: [...FLUSH_ALLOWED_TOOLS],
    maxTurns: FLUSH_MAX_TURNS,
    // autoMemoryEnabled:false (Friday owns memory via the friday-memory MCP);
    // the very large autoCompactWindow guarantees the flush never compacts.
    settings: { autoMemoryEnabled: false, autoCompactWindow: FLUSH_AUTO_COMPACT_WINDOW },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: COMPACT_FLUSH_SYSTEM_PROMPT,
    },
    // OVERRIDES.md #1: resume + forkSession give the flush the full
    // pre-compaction conversation WITHOUT polluting the user transcript
    // (forkSession mints a fresh session id for the flush's turns) and WITHOUT
    // recursion (this query registers no hooks).
    resume: sessionId,
    forkSession: true,
  };
}

/** Minimal projection of the memory index used to template the flush prompt —
 *  title + tags only, to bound the flush's own token budget. */
interface MemoryIndexEntry {
  title: string;
  tags: string[];
}

/** Render the projected memory index into the `[title — tags]` list the flush
 *  prompt references. Empty index renders an explicit "(no memories yet)" so
 *  the model isn't left guessing. */
function templateMemoryIndex(entries: MemoryIndexEntry[]): string {
  if (entries.length === 0) return "(no memories yet)";
  return entries
    .map((e) => {
      const tags = e.tags.length > 0 ? e.tags.join(", ") : "untagged";
      return `- ${e.title} — ${tags}`;
    })
    .join("\n");
}

/**
 * Run the PreCompact memory flush. Fetches the existing memory index via the
 * daemon HTTP boundary (the same path every worker memory op uses), templates
 * it into the flush prompt, runs the isolated sub-query, and counts
 * `memory_save` tool_use frames.
 *
 * Emits `memory-flush` WorkerEvents: `start` at entry, then `complete` with
 * `savedCount` on a clean finish. Throwing (or the SDK aborting on the 30s
 * matcher timeout) is caught by the caller in worker.ts, which emits the
 * `error` arm — so the OUTER turn is never affected by a flush failure.
 *
 * @param emit     the worker's IPC emit fn (parent → daemon).
 * @param signal   the hook's AbortSignal — forwarded to the index fetch AND
 *                 the sub-query so the 30s matcher timeout cancels both.
 */
export async function runMemoryFlush(
  opts: WorkerSpawnOptions,
  sessionId: string,
  mcpServers: FlushMcpServers,
  daemonPort: number,
  emit: (e: WorkerEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  emit({ type: "memory-flush", phase: "start", sessionId });

  // Load the existing memory index via the daemon's authoritative reader.
  // Project to title+tags before templating to bound the flush's tokens.
  const rawIndex = await daemonFetch<Array<{ title?: string; tags?: string[] }>>({
    port: daemonPort,
    path: "/api/memory",
    method: "GET",
    callerName: opts.agentName,
    callerType: opts.agentType,
    signal,
  });
  const index: MemoryIndexEntry[] = (Array.isArray(rawIndex) ? rawIndex : []).map((e) => ({
    title: typeof e.title === "string" ? e.title : "",
    tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : [],
  }));

  const prompt = `Existing memory index:\n${templateMemoryIndex(index)}`;

  let savedCount = 0;
  for await (const fm of query({
    prompt,
    options: buildFlushQueryOptions(opts, sessionId, mcpServers),
  })) {
    const m = fm as { type?: string; message?: { content?: unknown } };
    if (m.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; name?: string };
      if (b.type === "tool_use" && b.name === MEMORY_SAVE_TOOL) savedCount++;
    }
  }

  emit({ type: "memory-flush", phase: "complete", sessionId, savedCount });
}
