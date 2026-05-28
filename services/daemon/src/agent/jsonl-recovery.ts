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
 *    `(session_id, message_id, kind)`. The live worker's `block_index`
 *    is the SDK stream's position within the assembled message
 *    (thinking=0, text=1 in a thinking+text reply); the JSONL splits
 *    each content block into its own entry whose `content` array
 *    starts fresh at index 0, so `forEach((_, idx))` here is always 0.
 *    The two indices disagree by construction, so including
 *    `block_index` in the dedup caused recovery to insert a parallel
 *    row for the same logical text (FRI-4). `kind` stays in the key so
 *    thinking and text within one message remain separate rows.
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
 *  - Phase 5: net changes are picked up by Zero replication (the
 *    blocks reactive query); the legacy `block_reload` SSE event
 *    is retired. Diagnostic logging via `jsonl-recovery.session.applied` so
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
import { entryTs, parseEntries, type RawEntry } from "@friday/shared";
import { encodeProjectDir, sessionFilePath } from "./jsonl-paths.js";
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

export async function recoverFromJsonl(agents: RecoveryAgent[]): Promise<RecoveryStats> {
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
      const { inserted, updated, skipped, blockIds } = await reconcileSession(
        a.agentName,
        a.sessionId,
        filePath,
      );
      stats.sessionsScanned += 1;
      stats.inserted += inserted;
      stats.updated += updated;
      stats.skipped += skipped;
      // Phase 5 (SSE narrowing): the `block_reload` event was the
      // signal for the dashboard to re-fetch blocks via REST after
      // JSONL recovery touched rows. Zero's blocks reactive query
      // now auto-replicates those INSERTs/UPDATEs, so the event is
      // retired; we still log the recovery for diagnostics.
      if (blockIds.length > 0) {
        logger.log("info", "jsonl-recovery.session.applied", {
          agent: a.agentName,
          session: a.sessionId,
          inserted,
          updated,
          block_count: blockIds.length,
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

async function reconcileSession(
  agentName: string,
  sessionId: string,
  filePath: string,
): Promise<ReconcileResult> {
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
      await processAssistantEntry(out, agentName, sessionId, entry);
    } else if (type === "user") {
      await processUserEntry(out, agentName, sessionId, entry);
    }
    // Other entry types (system, summary, queue-operation, …) carry no
    // chat-visible blocks and are intentionally skipped.
  }
  return out;
}

async function processAssistantEntry(
  out: ReconcileResult,
  agentName: string,
  sessionId: string,
  entry: RawEntry,
): Promise<void> {
  const msg = entry.message as { id?: string; content?: unknown[] } | undefined;
  const messageId = msg?.id;
  if (!messageId || !Array.isArray(msg?.content)) {
    out.skipped += 1;
    return;
  }
  const ts = entryTs(entry);
  // Sequential — same `(messageId, kind)` natural key could otherwise
  // race itself between the existence check and the insert in
  // reconcileBlock.
  for (let idx = 0; idx < msg.content.length; idx++) {
    const b = msg.content[idx] as {
      type?: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
    if (b.type === "text" && typeof b.text === "string") {
      await reconcileBlock(out, {
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
      await reconcileBlock(out, {
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
      await reconcileToolUse(out, {
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
  }
}

async function processUserEntry(
  out: ReconcileResult,
  agentName: string,
  sessionId: string,
  entry: RawEntry,
): Promise<void> {
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
  const msg = entry.message as { id?: string | null; content?: unknown[] } | undefined;
  if (!Array.isArray(msg?.content)) {
    out.skipped += 1;
    return;
  }
  const ts = entryTs(entry);
  for (let idx = 0; idx < msg.content.length; idx++) {
    const b = msg.content[idx] as {
      type?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };
    if (b.type !== "tool_result" || !b.tool_use_id) continue;
    await reconcileToolResult(out, {
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
  }
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

async function reconcileBlock(out: ReconcileResult, input: ReconcileInput): Promise<void> {
  const existing = await getBlockByNaturalKey(input.sessionId, input.messageId, input.kind);
  if (!existing) {
    const blockId = randomUUID();
    const seq = eventBus.currentSeq() + 1;
    await insertBlock({
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
    });
    out.inserted += 1;
    out.blockIds.push(blockId);
    return;
  }
  if (sameContent(existing.contentJson, input.contentJson)) {
    out.skipped += 1;
    return;
  }
  const seq = eventBus.currentSeq() + 1;
  await updateBlock(existing.blockId, {
    contentJson: input.contentJson,
    status: "complete",
    ts: input.ts,
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
async function reconcileToolUse(out: ReconcileResult, input: ReconcileToolUseInput): Promise<void> {
  const existing = await getToolUseByToolUseId(input.sessionId, input.toolUseId);
  if (!existing) {
    const blockId = randomUUID();
    const seq = eventBus.currentSeq() + 1;
    await insertBlock({
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
    });
    out.inserted += 1;
    out.blockIds.push(blockId);
    return;
  }
  if (sameContent(existing.contentJson, input.contentJson)) {
    out.skipped += 1;
    return;
  }
  const seq = eventBus.currentSeq() + 1;
  await updateBlock(existing.blockId, {
    contentJson: input.contentJson,
    status: "complete",
    ts: input.ts,
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
async function reconcileToolResult(
  out: ReconcileResult,
  input: ReconcileToolResultInput,
): Promise<void> {
  const existing = await getToolResultByToolUseId(input.sessionId, input.toolUseId);
  if (!existing) {
    const blockId = randomUUID();
    const seq = eventBus.currentSeq() + 1;
    await insertBlock({
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
    });
    out.inserted += 1;
    out.blockIds.push(blockId);
    return;
  }
  if (sameContent(existing.contentJson, input.contentJson)) {
    out.skipped += 1;
    return;
  }
  const seq = eventBus.currentSeq() + 1;
  await updateBlock(existing.blockId, {
    contentJson: input.contentJson,
    status: "complete",
    ts: input.ts,
  });
  out.updated += 1;
  out.blockIds.push(existing.blockId);
}

/**
 * Structurally compare two JSON-string payloads. The existing row's
 * contentJson is stringified by the service layer from a jsonb-parsed
 * object — and Postgres jsonb storage does not preserve key order on
 * round-trip — so a byte-for-byte equality check spuriously declares the
 * JSONL freshly-stringified payload "different" on every recovery pass.
 * Parse both sides and deep-compare instead.
 */
function sameContent(a: string, b: string): boolean {
  if (a === b) return true;
  let pa: unknown;
  let pb: unknown;
  try {
    pa = JSON.parse(a);
    pb = JSON.parse(b);
  } catch {
    return false;
  }
  return canonical(pa) === canonical(pb);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Used by tests / debug tools: list all JSONL files under a project dir.
 * Boot recovery walks agents from the registry, not the filesystem.
 */
export function listSessionJsonlFiles(workingDirectory: string): string[] {
  const projectsDir = join(homedir(), ".claude", "projects", encodeProjectDir(workingDirectory));
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(projectsDir, f));
}
