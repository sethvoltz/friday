/**
 * JSONL recovery — boot pass + per-turn sweep (FIX_FORWARD 1.3).
 *
 * The live worker writes content blocks straight to the `blocks` table over
 * IPC (FIX_FORWARD 1.2). Two failure modes leak rows past the live pipeline:
 *
 *  - Daemon crashes mid-turn — workers die with the daemon and any
 *    in-flight `block-start` without a matching `block-stop` never lands.
 *  - Mid-turn iterator break (FIX_FORWARD 2.4) — the worker exits the SDK
 *    iterator at an assistant-message boundary when there's a queued user
 *    prompt or critical mail to inject, so the SDK's next yielded message
 *    (the user-role tool_results from that assistant's tool calls) never
 *    enters our IPC path. The tool_use's are persisted; their tool_results
 *    are only in the JSONL, which the SDK writes synchronously.
 *
 * `recoverFromJsonl` walks the Claude SDK JSONL for each given agent's
 * current session and reconciles against the DB:
 *
 *  - For each assistant `text` / `thinking` block, dedup by
 *    `(session_id, message_id, kind, block_index)`. The Claude SDK
 *    splits a multi-block assistant message into per-block JSONL
 *    entries (each starting at content `index: 0`), so a thinking-chunk
 *    and a text-chunk land at the same nominal `(message_id, 0)`. Without
 *    `kind` in the key those collide and one's contentJson gets clobbered
 *    by the other (with no `kind` change — `updateBlock` can't move it).
 *    Missing → INSERT with a fresh UUID and `status='complete'`.
 *    Mismatched content → UPDATE.
 *  - For each assistant `tool_use` block, dedup by `(session_id,
 *    tool_use_id)`. The SDK-stream's global `e.index` (what the live IPC
 *    path stores as block_index) doesn't agree with the JSONL entry's
 *    content-array position, so `tool_use_id` is the only stable
 *    cross-reference for matching live ↔ recovered rows.
 *  - For each user `tool_result` block, dedup by
 *    `(session_id, tool_use_id)`. Tool_result entries in the SDK's JSONL
 *    never carry a stable `message.id` (they're flushed before the API
 *    assigns one), so an assistant-style natural key always misses;
 *    `tool_use_id` is the cross-reference the Anthropic API uses to pair
 *    use ↔ result.
 *  - User-role text content is ignored: those blocks are written by the
 *    daemon at chat/turn / mail-bridge time, never derived from JSONL.
 *  - A `block_reload` SSE event fires per session with any net changes so
 *    connected dashboards can refetch.
 *
 * Invocation sites:
 *  - Boot: index.ts walks every agent with a sessionId once after
 *    migrations land.
 *  - Per turn: lifecycle.ts's `turn-complete` handler schedules a sweep
 *    for the just-finished agent's session (fire-and-forget via
 *    setImmediate), so mid-turn-break drift heals within seconds rather
 *    than waiting for the next daemon restart.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  entryTs,
  parseEntries,
  type RawEntry,
} from "@friday/shared";
import {
  getBlockByNaturalKey,
  getToolResultByToolUseId,
  getToolUseByToolUseId,
  insertBlock,
  updateBlock,
} from "@friday/shared/services";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import { stringifyToolResult } from "@friday/shared";

export interface RecoveryStats {
  sessionsScanned: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export interface RecoveryAgent {
  agentName: string;
  sessionId: string;
  workingDirectory: string;
}

export function recoverFromJsonl(agents: RecoveryAgent[]): RecoveryStats {
  const stats: RecoveryStats = {
    sessionsScanned: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
  };

  for (const a of agents) {
    const filePath = sessionFilePath(a.workingDirectory, a.sessionId);
    if (!existsSync(filePath)) continue;
    try {
      const { inserted, updated, skipped, blockIds } = reconcileSession(
        a.agentName,
        a.sessionId,
        filePath,
      );
      stats.sessionsScanned += 1;
      stats.inserted += inserted;
      stats.updated += updated;
      stats.skipped += skipped;
      if (blockIds.length > 0) {
        eventBus.publish({
          v: 1,
          type: "block_reload",
          agent: a.agentName,
          session_id: a.sessionId,
          block_ids: blockIds,
          inserted,
          updated,
          ts: Date.now(),
        });
      }
    } catch (err) {
      logger.log("warn", "jsonl-recovery.session.error", {
        agent: a.agentName,
        session: a.sessionId,
        filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.log("info", "jsonl-recovery.done", {
    sessionsScanned: stats.sessionsScanned,
    inserted: stats.inserted,
    updated: stats.updated,
    skipped: stats.skipped,
  });
  return stats;
}

interface ReconcileResult {
  inserted: number;
  updated: number;
  skipped: number;
  blockIds: string[];
}

function reconcileSession(
  agentName: string,
  sessionId: string,
  filePath: string,
): ReconcileResult {
  const out: ReconcileResult = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    blockIds: [],
  };
  // statSync solely to avoid pathological reads; the SDK's per-session JSONL
  // is rarely larger than tens of MB even for long-running orchestrators.
  if (!statSync(filePath).isFile()) return out;
  const raw = readFileSync(filePath, "utf8");
  for (const entry of parseEntries(raw)) {
    if ((entry as { isSidechain?: boolean }).isSidechain === true) continue;
    const type = (entry.type ?? "") as string;
    if (type === "assistant") {
      processAssistantEntry(out, agentName, sessionId, entry);
    } else if (type === "user") {
      processUserEntry(out, agentName, sessionId, entry);
    }
    // Other entry types (system, summary, queue-operation, …) carry no
    // chat-visible blocks and are intentionally skipped.
  }
  return out;
}

function processAssistantEntry(
  out: ReconcileResult,
  agentName: string,
  sessionId: string,
  entry: RawEntry,
): void {
  const msg = entry.message as
    | { id?: string; content?: unknown[] }
    | undefined;
  const messageId = msg?.id;
  if (!messageId || !Array.isArray(msg?.content)) {
    out.skipped += 1;
    return;
  }
  const ts = entryTs(entry);
  msg.content.forEach((rawBlock, idx) => {
    const b = rawBlock as {
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
    if (b.type === "text" && typeof b.text === "string") {
      reconcileBlock(out, {
        agentName,
        sessionId,
        messageId,
        blockIndex: idx,
        role: "assistant",
        kind: "text",
        source: null,
        contentJson: JSON.stringify({ text: b.text }),
        ts,
      });
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      reconcileBlock(out, {
        agentName,
        sessionId,
        messageId,
        blockIndex: idx,
        role: "assistant",
        kind: "thinking",
        source: null,
        contentJson: JSON.stringify({ text: b.thinking }),
        ts,
      });
    } else if (b.type === "tool_use") {
      const toolUseId = b.id ?? `idx_${idx}`;
      reconcileToolUse(out, {
        agentName,
        sessionId,
        messageId,
        blockIndex: idx,
        toolUseId,
        contentJson: JSON.stringify({
          tool_use_id: toolUseId,
          name: b.name ?? "",
          input: b.input ?? {},
        }),
        ts,
      });
    }
  });
}

function processUserEntry(
  out: ReconcileResult,
  agentName: string,
  sessionId: string,
  entry: RawEntry,
): void {
  // Only reconcile tool_result blocks from user entries — the user's typed
  // prompts are already persisted via /api/chat/turn (and mail user-blocks
  // via mail-bridge). Importing user-text from JSONL would duplicate them.
  //
  // Tool_result entries in the SDK's JSONL never carry a `message.id`
  // (user-role messages get their ids minted later, often null on flush).
  // The original `(sessionId, messageId, blockIndex)` natural-key dedup
  // therefore skipped every tool_result entry — orphaning them in DB
  // forever even after a daemon restart. We now dedup tool_results by
  // `(sessionId, tool_use_id)` instead (see reconcileToolResult below),
  // so a null message_id is fine and we keep walking the content array.
  const msg = entry.message as
    | { id?: string | null; content?: unknown[] }
    | undefined;
  if (!Array.isArray(msg?.content)) {
    out.skipped += 1;
    return;
  }
  const ts = entryTs(entry);
  msg.content.forEach((rawBlock, idx) => {
    const b = rawBlock as {
      type?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };
    if (b.type !== "tool_result" || !b.tool_use_id) return;
    reconcileToolResult(out, {
      agentName,
      sessionId,
      messageId: msg?.id ?? null,
      blockIndex: idx,
      toolUseId: b.tool_use_id,
      contentJson: JSON.stringify({
        tool_use_id: b.tool_use_id,
        text: stringifyToolResult(b.content),
        is_error: b.is_error === true,
      }),
      ts,
    });
  });
}

interface ReconcileInput {
  agentName: string;
  sessionId: string;
  messageId: string;
  blockIndex: number;
  role: string;
  kind: "text" | "thinking";
  source: null;
  contentJson: string;
  ts: number;
}

function reconcileBlock(
  out: ReconcileResult,
  input: ReconcileInput,
): void {
  const existing = getBlockByNaturalKey(
    input.sessionId,
    input.messageId,
    input.kind,
    input.blockIndex,
  );
  if (!existing) {
    const blockId = randomUUID();
    const seq = eventBus.currentSeq() + 1;
    insertBlock({
      blockId,
      // turnId is unknown for recovered rows (the original turn_id lived in
      // worker memory at write time). Use a recovery-tagged id so callers can
      // tell these rows apart from live-written ones.
      turnId: `recover_${input.sessionId}`,
      agentName: input.agentName,
      sessionId: input.sessionId,
      messageId: input.messageId,
      blockIndex: input.blockIndex,
      role: input.role,
      kind: input.kind,
      source: input.source,
      contentJson: input.contentJson,
      status: "complete",
      ts: input.ts,
      lastEventSeq: seq,
    });
    out.inserted += 1;
    out.blockIds.push(blockId);
    return;
  }
  if (existing.contentJson === input.contentJson) {
    out.skipped += 1;
    return;
  }
  const seq = eventBus.currentSeq() + 1;
  updateBlock(existing.blockId, {
    contentJson: input.contentJson,
    status: "complete",
    ts: input.ts,
    lastEventSeq: seq,
  });
  out.updated += 1;
  out.blockIds.push(existing.blockId);
}

interface ReconcileToolUseInput {
  agentName: string;
  sessionId: string;
  messageId: string;
  /** Block index from the JSONL entry's `content` array (usually 0 because
   *  the SDK splits a multi-block message into per-block entries). The
   *  live IPC may store the same row at a different block_index — that's
   *  fine because dedup is by `tool_use_id`, not `(message_id, block_index)`. */
  blockIndex: number;
  toolUseId: string;
  contentJson: string;
  ts: number;
}

/**
 * Tool_use variant of reconcileBlock. Dedup is by `(session_id,
 * tool_use_id)` because the SDK splits a multi-block assistant message
 * into per-block JSONL entries (each starting at content `index: 0`),
 * while the live IPC path stores tool_use at the SDK-stream's global
 * `e.index`. Those two block_index values don't agree; dedup'ing by
 * `tool_use_id` (stable, unique) keeps recovery idempotent against
 * live-written rows regardless of streaming-chunk boundaries.
 */
function reconcileToolUse(
  out: ReconcileResult,
  input: ReconcileToolUseInput,
): void {
  const existing = getToolUseByToolUseId(input.sessionId, input.toolUseId);
  if (!existing) {
    const blockId = randomUUID();
    const seq = eventBus.currentSeq() + 1;
    insertBlock({
      blockId,
      turnId: `recover_${input.sessionId}`,
      agentName: input.agentName,
      sessionId: input.sessionId,
      messageId: input.messageId,
      blockIndex: input.blockIndex,
      role: "assistant",
      kind: "tool_use",
      source: null,
      contentJson: input.contentJson,
      status: "complete",
      ts: input.ts,
      lastEventSeq: seq,
    });
    out.inserted += 1;
    out.blockIds.push(blockId);
    return;
  }
  if (existing.contentJson === input.contentJson) {
    out.skipped += 1;
    return;
  }
  const seq = eventBus.currentSeq() + 1;
  updateBlock(existing.blockId, {
    contentJson: input.contentJson,
    status: "complete",
    ts: input.ts,
    lastEventSeq: seq,
  });
  out.updated += 1;
  out.blockIds.push(existing.blockId);
}

interface ReconcileToolResultInput {
  agentName: string;
  sessionId: string;
  /** Almost always null in practice — see processUserEntry's comment. */
  messageId: string | null;
  blockIndex: number;
  toolUseId: string;
  contentJson: string;
  ts: number;
}

/**
 * Tool_result variant of reconcileBlock. Dedup is by `(session_id,
 * tool_use_id)` because the JSONL never carries a stable message_id for
 * these entries. Inserts with `message_id = null` if absent.
 */
function reconcileToolResult(
  out: ReconcileResult,
  input: ReconcileToolResultInput,
): void {
  const existing = getToolResultByToolUseId(input.sessionId, input.toolUseId);
  if (!existing) {
    const blockId = randomUUID();
    const seq = eventBus.currentSeq() + 1;
    insertBlock({
      blockId,
      turnId: `recover_${input.sessionId}`,
      agentName: input.agentName,
      sessionId: input.sessionId,
      messageId: input.messageId,
      blockIndex: input.blockIndex,
      role: "assistant",
      kind: "tool_result",
      source: null,
      contentJson: input.contentJson,
      status: "complete",
      ts: input.ts,
      lastEventSeq: seq,
    });
    out.inserted += 1;
    out.blockIds.push(blockId);
    return;
  }
  if (existing.contentJson === input.contentJson) {
    out.skipped += 1;
    return;
  }
  const seq = eventBus.currentSeq() + 1;
  updateBlock(existing.blockId, {
    contentJson: input.contentJson,
    status: "complete",
    ts: input.ts,
    lastEventSeq: seq,
  });
  out.updated += 1;
  out.blockIds.push(existing.blockId);
}

function sessionFilePath(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const projectsDir = join(homedir(), ".claude", "projects");
  return join(projectsDir, encoded, `${sessionId}.jsonl`);
}

/**
 * Used by tests / debug tools: list all JSONL files under a project dir.
 * Boot recovery walks agents from the registry, not the filesystem.
 */
export function listSessionJsonlFiles(workingDirectory: string): string[] {
  const encoded = workingDirectory.replace(/[^a-zA-Z0-9]/g, "-");
  const projectsDir = join(homedir(), ".claude", "projects", encoded);
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(projectsDir, f));
}
