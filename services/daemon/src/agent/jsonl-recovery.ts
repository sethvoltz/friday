/**
 * Boot-time JSONL recovery (FIX_FORWARD 1.3).
 *
 * The live worker writes content blocks straight to the `blocks` table over
 * IPC (FIX_FORWARD 1.2). If the daemon crashes mid-turn the workers die with
 * it, and we may have missed the final block-stop for one or more in-flight
 * blocks. At boot, after migrations land, we walk each known agent's Claude
 * SDK JSONL file and reconcile it against the DB:
 *
 *  - For each assistant text / thinking / tool_use block and user
 *    `tool_result` block in the transcript, look up `(session_id,
 *    message_id, block_index)`. If missing → INSERT with a fresh UUID and
 *    `status='complete'`. If present but content_json mismatches → UPDATE.
 *  - User-role text content is ignored: those blocks are written by the
 *    daemon at chat/turn / mail-bridge time, never derived from JSONL.
 *  - A `block_reload` SSE event fires per session with any net changes so
 *    connected dashboards can refetch.
 *
 * No live tail. No periodic scanning. Run once on daemon start.
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
      reconcileBlock(out, {
        agentName,
        sessionId,
        messageId,
        blockIndex: idx,
        role: "assistant",
        kind: "tool_use",
        source: null,
        contentJson: JSON.stringify({
          tool_use_id: b.id ?? `idx_${idx}`,
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
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };
    if (b.type !== "tool_result" || !b.tool_use_id) return;
    reconcileBlock(out, {
      agentName,
      sessionId,
      messageId,
      blockIndex: idx,
      role: "assistant",
      kind: "tool_result",
      source: null,
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
  kind: "text" | "thinking" | "tool_use" | "tool_result";
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
