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
 *   - The flush is STRUCTURALLY restricted to memory only — not merely
 *     prompt-steered. Built-in tools are disabled (`tools: []` → no Bash, no
 *     Read/Write/Edit/Glob/Grep), the MCP set is reduced to `friday-memory`
 *     alone (see {@link memoryOnlyMcpServers} — mail/tickets/evolve/apps/
 *     integrations/user servers are dropped), and `allowedTools` auto-approves
 *     exactly the three memory tools (search / get / save). Because the flush
 *     fork-resumes the full pre-compaction conversation (which can carry
 *     untrusted ingested content) under `bypassPermissions` with no
 *     PreToolUse hook, restricting AVAILABILITY — not just the auto-approve
 *     list — is the security boundary: an injected "email/delete/exec"
 *     instruction has no tool to land on. A flush APPENDS new memory
 *     (search-before-save is the store's own dedup discipline); it must not
 *     mutate or delete existing entries, so `memory_update` / `memory_forget`
 *     are omitted from `allowedTools`.
 *   - The flush prompt is templated with the existing memory INDEX (title +
 *     tags only, to bound the flush's own token budget) so the model can
 *     dedup against what's already saved. The prompt is INDEPENDENT of
 *     FRI-156's persona `custom_instructions` — the two tickets stay
 *     decoupled (the flush never reads `custom_instructions`).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { daemonFetch } from "../mcp/http.js";
import { MEMORY_SERVER_NAME } from "../mcp/memory.js";
import type { WorkerEvent, WorkerSpawnOptions } from "./worker-protocol.js";

type QueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;
type FlushMcpServers = QueryOptions["mcpServers"];

/**
 * Reduce the worker's full MCP server set to the memory-only subset the flush
 * is allowed to touch. `allowedTools` is an auto-APPROVE list, not an
 * availability filter (sdk.d.ts: "To restrict which tools are available, use
 * the `tools` option instead"). Under `bypassPermissions` every AVAILABLE tool
 * is auto-approved with no prompt and no hook, so leaving mail/tickets/evolve/
 * apps/integrations/user-MCP servers in the set would make them callable by the
 * flush model (which fork-resumes the full — possibly untrusted-content-bearing
 * — pre-compaction conversation). Passing only `friday-memory` is the structural
 * sandbox: an injected "email/delete/exec" instruction has no tool to land on.
 * Paired with `tools: []` (built-ins off) in {@link buildFlushQueryOptions}.
 */
export function memoryOnlyMcpServers(mcpServers: FlushMcpServers): FlushMcpServers {
  if (!mcpServers || typeof mcpServers !== "object") return {};
  const memory = (mcpServers as Record<string, unknown>)[MEMORY_SERVER_NAME];
  return memory === undefined
    ? {}
    : ({ [MEMORY_SERVER_NAME]: memory } as unknown as FlushMcpServers);
}

/** The three friday-memory MCP tools the flush is allowed to call. Exactly
 *  these — search + get to dedup, save to append. No update/forget (a flush
 *  never mutates or deletes existing memory). Pinned by worker.test.ts. */
export const FLUSH_ALLOWED_TOOLS = [
  "mcp__friday-memory__memory_search",
  "mcp__friday-memory__memory_get",
  "mcp__friday-memory__memory_save",
] as const;

/** The memory_save tool name. `savedCount` counts SUCCESSFUL save tool_results
 *  (the FRI-27 AC is "rows LAND IN POSTGRES"), not bare invocations: a save
 *  whose MCP handler rejects (validation) or whose POST throws still emits a
 *  tool_use frame but lands no row, so we correlate the tool_use id to its
 *  non-error tool_result. */
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
 * conversation, forked off the user transcript), `tools: []` (built-ins off),
 * `mcpServers` reduced to memory-only, `allowedTools` exactly the three memory
 * tools, `disallowedTools` includes 'Task', `autoCompactWindow` is the large
 * disable value, and (when an `abortController` is supplied) `abortController`
 * is set so the hook's 30s matcher timeout actually tears the flush down.
 *
 * `sessionId` is the about-to-be-compacted session from `PreCompactHookInput`
 * (resolved by the worker). forkSession requires resume (sdk.d.ts:1278), so
 * both are always set together.
 *
 * @param abortController wired to the hook's AbortSignal by the caller so an
 *   abort tears down the in-flight flush sub-query (the SDK's only abort lever
 *   is `options.abortController`). Optional so tests can assert both shapes.
 */
export function buildFlushQueryOptions(
  opts: WorkerSpawnOptions,
  sessionId: string,
  mcpServers: FlushMcpServers,
  abortController?: AbortController,
): QueryOptions {
  return {
    cwd: opts.workingDirectory,
    model: opts.model,
    permissionMode: "bypassPermissions",
    // SDK contract: bypassPermissions "requires allowDangerouslySkipPermissions"
    // (sdk.d.ts). Honored explicitly so a future SDK that begins enforcing the
    // flag doesn't break the flush. Safe here because availability is already
    // hard-restricted to the three memory tools (tools:[] + memory-only MCP).
    allowDangerouslySkipPermissions: true,
    // STRUCTURAL sandbox (not prompt-steered): memory-only MCP set + built-ins
    // disabled. `allowedTools` only auto-APPROVES; availability is governed by
    // `tools` (built-ins) and the MCP set. Together with bypassPermissions +
    // no hooks, this is what stops an injected instruction in the fork-resumed
    // conversation from reaching Bash/mail_send/evolve_apply/etc.
    mcpServers: memoryOnlyMcpServers(mcpServers),
    // `[]` disables ALL built-in tools (Bash/Read/Write/Edit/Glob/Grep).
    tools: [],
    // No Task sub-agent, and exactly the three memory tools — nothing else.
    disallowedTools: ["Task"],
    allowedTools: [...FLUSH_ALLOWED_TOOLS],
    maxTurns: FLUSH_MAX_TURNS,
    // autoMemoryEnabled:false (Friday owns memory via the friday-memory MCP);
    // the very large autoCompactWindow guarantees the flush never compacts.
    settings: { autoMemoryEnabled: false, autoCompactWindow: FLUSH_AUTO_COMPACT_WINDOW },
    // FRI-27: thread the hook's abort into the SDK so the 30s matcher timeout
    // (and any worker stop/abort) actually cancels the in-flight flush query —
    // mirrors the main turn (buildQueryOptions). Without this the flush
    // subprocess + its for-await loop keep running after compaction proceeds.
    ...(abortController ? { abortController } : {}),
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
 * `memory_save` rows that actually LANDED (non-error tool_results), not bare
 * invocations.
 *
 * Emits `memory-flush` WorkerEvents: `start` at entry, then `complete` with
 * `savedCount` on a clean finish. Throwing (or the SDK aborting on the 30s
 * matcher timeout) is caught by the caller in worker.ts, which emits the
 * `error` arm — so the OUTER turn is never affected by a flush failure.
 *
 * @param emit     the worker's IPC emit fn (parent → daemon).
 * @param signal   the hook's AbortSignal — forwarded to the index fetch AND,
 *                 via an AbortController, to the flush sub-query's
 *                 `options.abortController`, so the 30s matcher timeout (or a
 *                 worker stop/abort) cancels both. The for-await loop also
 *                 breaks on `signal.aborted` so a teardown stops counting.
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

  // Bridge the hook's AbortSignal to an AbortController — the SDK's only
  // query() abort lever is `options.abortController`. Aborting it tears the
  // flush subprocess down (the index fetch already takes the raw signal).
  const flushAbort = new AbortController();
  if (signal.aborted) flushAbort.abort();
  else signal.addEventListener("abort", () => flushAbort.abort(), { once: true });

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

  // memory_save tool_use ids seen on assistant frames, so the matching
  // tool_result (carried on the next `user` frame) can be scored: a save counts
  // toward `savedCount` only when its tool_result is NOT an error, i.e. the row
  // actually landed in Postgres. Validation rejections (rejectionResult) and
  // POST failures both surface as is_error tool_results and are excluded.
  const pendingSaveIds = new Set<string>();
  let savedCount = 0;
  for await (const fm of query({
    prompt,
    options: buildFlushQueryOptions(opts, sessionId, mcpServers, flushAbort),
  })) {
    // Stop iterating the moment the flush is aborted — compaction has
    // proceeded; the for-await loop must not keep counting a torn-down flush.
    if (signal.aborted) break;
    const m = fm as { type?: string; message?: { content?: unknown } };
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    if (m.type === "assistant") {
      for (const block of content) {
        const b = block as { type?: string; name?: string; id?: string };
        if (b.type === "tool_use" && b.name === MEMORY_SAVE_TOOL && typeof b.id === "string") {
          pendingSaveIds.add(b.id);
        }
      }
    } else if (m.type === "user") {
      for (const block of content) {
        const b = block as { type?: string; tool_use_id?: string; is_error?: boolean };
        if (
          b.type === "tool_result" &&
          typeof b.tool_use_id === "string" &&
          pendingSaveIds.delete(b.tool_use_id) &&
          b.is_error !== true
        ) {
          savedCount++;
        }
      }
    }
  }

  emit({ type: "memory-flush", phase: "complete", sessionId, savedCount });
}
