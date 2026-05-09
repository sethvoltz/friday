/**
 * Tail-watcher that mirrors Claude SDK session JSONL files into the `turns`
 * table. The SDK writes per-session JSONL under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. We watch the file and
 * append parsed entries on every change.
 *
 * Idempotent on (sessionId, turnIndex). turnIndex == byte offset in the
 * source file — that's monotonic by construction and unique within a session,
 * so partial-drain idempotency is automatic.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watchFile,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  entryRole,
  entryTs,
  parseEntriesWithOffsets,
  type EntryWithOffset,
} from "@friday/shared";
import { upsertTurn } from "@friday/shared/services";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";

const watchers = new Map<
  string,
  { sessionId: string; agentName: string; lastSize: number }
>();

const POLL_INTERVAL_MS = 500;

export function startMirror(opts: {
  sessionId: string;
  agentName: string;
  workingDirectory: string;
}): void {
  const filePath = sessionFilePath(opts.workingDirectory, opts.sessionId);
  if (watchers.has(filePath)) return;
  watchers.set(filePath, {
    sessionId: opts.sessionId,
    agentName: opts.agentName,
    lastSize: 0,
  });
  // Initial drain (if file already exists) + start watching.
  drain(filePath);
  // `watchFile` works even for files that don't yet exist; once the SDK
  // creates the JSONL, the watcher fires and drain runs.
  watchFile(filePath, { interval: POLL_INTERVAL_MS }, () => drain(filePath));
  logger.log("info", "jsonl-mirror.start", {
    filePath,
    sessionId: opts.sessionId,
    agentName: opts.agentName,
  });
}

function sessionFilePath(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const projectsDir = join(homedir(), ".claude", "projects");
  return join(projectsDir, encoded, `${sessionId}.jsonl`);
}

function drain(filePath: string): void {
  const w = watchers.get(filePath);
  if (!w) return;
  if (!existsSync(filePath)) return;
  const stat = statSync(filePath);
  if (stat.size <= w.lastSize) return;

  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch (err) {
    logger.log("warn", "jsonl-mirror.open.fail", {
      filePath,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  try {
    const buf = Buffer.alloc(stat.size - w.lastSize);
    readSync(fd, buf, 0, buf.length, w.lastSize);
    const chunk = buf.toString("utf8");
    const offsetBase = w.lastSize;
    const entries = parseEntriesWithOffsets(chunk);
    for (const e of entries) {
      ingestEntry(e, w.sessionId, w.agentName, filePath, offsetBase);
    }
    w.lastSize = stat.size;
  } catch (err) {
    logger.log("warn", "jsonl-mirror.drain.error", {
      filePath,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function ingestEntry(
  e: EntryWithOffset,
  sessionId: string,
  agentName: string,
  filePath: string,
  offsetBase: number,
): void {
  // Filter out non-message entries (queue-operation, internal SDK noise) —
  // they'd otherwise fill the table with rows the chat doesn't render.
  const t = (e.entry.type ?? "") as string;
  if (
    t !== "user" &&
    t !== "assistant" &&
    t !== "system" &&
    t !== "tool_use" &&
    t !== "tool_result"
  ) {
    return;
  }

  // SDK Task sub-agent entries are written into the same JSONL with
  // `isSidechain: true`. Skip them so reload/replay doesn't surface sub-agent
  // tool blocks in the orchestrator's chat (mirroring the live-stream filter
  // applied in the worker).
  if ((e.entry as { isSidechain?: boolean }).isSidechain === true) {
    return;
  }

  const role = entryRole(e.entry);
  const ts = entryTs(e.entry);
  const seq = eventBus.currentSeq() + 1;
  // Use the byte offset as the turnIndex — monotonic, unique within a
  // session, and idempotent across re-drains.
  const turnIndex = offsetBase + e.byteOff;
  upsertTurn({
    sessionId,
    agentName,
    turnIndex,
    ts,
    role,
    kind: t,
    contentJson: e.rawJson,
    sourceFile: filePath,
    sourceByteOff: turnIndex,
    lastEventSeq: seq,
  });
}
