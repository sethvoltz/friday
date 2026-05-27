/**
 * Append a synthetic `tool_result` entry to a Claude Agent SDK session
 * transcript so a session that ends on an unresolved `tool_use` can be
 * resumed cleanly.
 *
 * The SDK reads `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` on
 * `resume:` and refuses to continue if the last assistant message contains
 * a `tool_use` with no matching `tool_result` afterwards. By appending a
 * properly-formed `user/tool_result` line at EOF we close that gap without
 * having to clear the session — preserving conversational continuity, which
 * is Friday's load-bearing principle for the orchestrator chat.
 *
 * Idempotent: scans the existing transcript for an entry whose
 * `message.content[0].tool_use_id` matches; if found, skips the write.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { sessionFilePath } from "./jsonl-paths.js";
import { parseEntries } from "@friday/shared";

export interface HealJsonlInput {
  /** Absolute cwd the agent's worker runs under. Resolves via `workingDirectoryFor`. */
  cwd: string;
  /** SDK session UUID. */
  sessionId: string;
  /** The dangling `tool_use_id` we're resolving. */
  toolUseId: string;
  /** User-visible marker copied into the synthetic tool_result content. */
  healMarker: string;
}

export type HealJsonlResult =
  | { written: true; path: string }
  | {
      written: false;
      reason: "transcript-missing" | "tool-use-not-found" | "already-resolved";
      path: string;
    };

/**
 * Find the assistant entry containing a `tool_use` block with the given id.
 * Returns its uuid so the synthetic tool_result can chain via `parentUuid`,
 * mirroring how the SDK chains its own writes.
 */
function findToolUseUuid(jsonl: string, toolUseId: string): string | null {
  for (const entry of parseEntries(jsonl)) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_use" &&
        (block as { id?: string }).id === toolUseId
      ) {
        return typeof entry.uuid === "string" ? entry.uuid : null;
      }
    }
  }
  return null;
}

/**
 * Check whether a tool_result for this tool_use_id is already present in
 * the transcript. Lets the heal stay idempotent across reruns.
 */
function hasMatchingToolResult(jsonl: string, toolUseId: string): boolean {
  for (const entry of parseEntries(jsonl)) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "tool_result" &&
        (block as { tool_use_id?: string }).tool_use_id === toolUseId
      ) {
        return true;
      }
    }
  }
  return false;
}

interface SyntheticEntry {
  parentUuid: string;
  isSidechain: false;
  type: "user";
  message: {
    role: "user";
    content: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error: true;
    }>;
  };
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  userType: "external";
  entrypoint: "sdk-ts";
  version: string;
  gitBranch: string;
}

function buildSyntheticEntry(opts: {
  parentUuid: string;
  toolUseId: string;
  healMarker: string;
  sessionId: string;
  cwd: string;
}): SyntheticEntry {
  return {
    parentUuid: opts.parentUuid,
    isSidechain: false,
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: opts.toolUseId,
          content: opts.healMarker,
          is_error: true,
        },
      ],
    },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    userType: "external",
    entrypoint: "sdk-ts",
    version: "friday-heal",
    gitBranch: "HEAD",
  };
}

/**
 * Append a synthetic `tool_result` line to the SDK's session transcript
 * for the given `toolUseId`. No-ops gracefully when the transcript file is
 * absent (long-cleared session, fresh agent, test environment) and when
 * a matching tool_result already exists.
 */
export function healDanglingToolUseInJsonl(input: HealJsonlInput): HealJsonlResult {
  const path = sessionFilePath(input.cwd, input.sessionId);
  if (!existsSync(path)) {
    return { written: false, reason: "transcript-missing", path };
  }
  const jsonl = readFileSync(path, "utf8");
  if (hasMatchingToolResult(jsonl, input.toolUseId)) {
    return { written: false, reason: "already-resolved", path };
  }
  const toolUseUuid = findToolUseUuid(jsonl, input.toolUseId);
  if (!toolUseUuid) {
    return { written: false, reason: "tool-use-not-found", path };
  }
  const entry = buildSyntheticEntry({
    parentUuid: toolUseUuid,
    toolUseId: input.toolUseId,
    healMarker: input.healMarker,
    sessionId: input.sessionId,
    cwd: input.cwd,
  });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  return { written: true, path };
}
