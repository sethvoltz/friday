/**
 * Boot-time self-heal for SDK sessions wedged on an unresolved
 * `tool_use`.
 *
 * Failure mode this closes: an assistant block emits a `tool_use`,
 * the worker is supposed to execute the tool and write a matching
 * `tool_result`, but the worker dies before the result lands —
 * `kill -9`, OOM, daemon crash, segfault, OS sleep, etc. The
 * Claude Agent SDK's session is now stuck mid-tool-call. Any next
 * turn fed into that session returns zero blocks: Claude refuses
 * to continue a conversation that has an unresolved `tool_use`.
 *
 * From the operator's view: the agent stops responding. "Keep going"
 * gets logged as `Agent didn't respond`. There's no surface error.
 *
 * Discovered during the FRI-88 brew flip: a `kill -9` zombie cleanup
 * caught `trmnl-kitchen-research`'s worker mid-`Agent`-tool sub-agent
 * spawn. A scan turned up **7 wedged agents** across the install,
 * the oldest dating to 2026-05-14 — every previous unclean worker
 * shutdown that landed on a `tool_use` had left the same dangling
 * state, with no operator recourse short of manual `/clear`.
 *
 * The heal:
 *  1. Insert a synthetic `tool_result` block in Postgres marking
 *     the tool as interrupted. The dashboard renders it, so the
 *     operator sees what happened without having to read a log.
 *  2. Clear the agent's `session_id`. The next dispatched turn
 *     forks a fresh SDK session, bypassing the wedged JSONL
 *     transcript entirely. Conversation history stays in Postgres
 *     for reference; Claude just doesn't see it in the new session.
 *
 * Archived agents are intentionally skipped — no one's going to
 * send them new turns, so the dangling state is inert.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@friday/shared";
import { insertBlock } from "@friday/shared/services";
import * as registry from "./registry.js";
import { logger } from "../log.js";

interface DanglingToolUseRow {
  agent_name: string;
  turn_id: string;
  session_id: string;
  tool_use_id: string;
  ts: Date;
  [key: string]: unknown;
}

const HEAL_MARKER =
  "[Tool call interrupted by daemon restart — agent session was reset. Send a new message to continue with a fresh context.]";

export async function recoverDanglingToolUses(): Promise<void> {
  const db = getDb();
  // Find every `tool_use` block whose `tool_use_id` has no matching
  // `tool_result` block scoped to the same agent. Group by agent so
  // we clear each session at most once.
  const result = await db.execute<DanglingToolUseRow>(sql`
    SELECT
      b.agent_name,
      b.turn_id,
      b.session_id,
      (b.content_json->>'tool_use_id') AS tool_use_id,
      b.ts
    FROM blocks b
    WHERE b.kind = 'tool_use'
      AND b.content_json->>'tool_use_id' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM blocks r
        WHERE r.kind = 'tool_result'
          AND r.content_json->>'tool_use_id' = b.content_json->>'tool_use_id'
          AND r.agent_name = b.agent_name
      )
    ORDER BY b.ts ASC
  `);

  // drizzle's `execute` returns either an array or a `{ rows }` wrapper
  // depending on driver — handle both.
  const rows: DanglingToolUseRow[] = Array.isArray(result)
    ? (result as unknown as DanglingToolUseRow[])
    : (result as { rows: DanglingToolUseRow[] }).rows ?? [];

  if (rows.length === 0) {
    logger.log("info", "dangling-tool-use-recovery.scan", { found: 0 });
    return;
  }

  const byAgent = new Map<string, DanglingToolUseRow[]>();
  for (const row of rows) {
    const arr = byAgent.get(row.agent_name) ?? [];
    arr.push(row);
    byAgent.set(row.agent_name, arr);
  }

  logger.log("warn", "dangling-tool-use-recovery.found", {
    count: rows.length,
    agents: [...byAgent.keys()],
  });

  let healedAgents = 0;
  let healedBlocks = 0;
  let skippedAgents = 0;

  for (const [agentName, orphans] of byAgent) {
    const agent = await registry.getAgent(agentName);
    if (!agent) {
      // Agent row was deleted out from under the blocks (shouldn't
      // happen given the FK, but defensive). Nothing to heal.
      skippedAgents++;
      continue;
    }
    if (agent.status === "archived") {
      // Intentionally closed; the dangling state is inert because no
      // one will dispatch a turn against it. Leave it alone.
      logger.log("info", "dangling-tool-use-recovery.skip-archived", {
        agent: agentName,
        count: orphans.length,
      });
      skippedAgents++;
      continue;
    }

    // Write one synthetic tool_result per dangling tool_use, then clear
    // the session once for the agent.
    for (const orphan of orphans) {
      const tsBase = new Date(orphan.ts).getTime();
      try {
        await insertBlock({
          blockId: randomUUID(),
          turnId: orphan.turn_id,
          agentName: orphan.agent_name,
          sessionId: orphan.session_id,
          // Synthetic blocks go after the original tool_use; +1ms keeps
          // chronological ordering stable without colliding with the
          // worker's next genuine block (workers emit ms-grained ts so
          // a 1ms offset is enough).
          blockIndex: 0,
          role: "user",
          kind: "tool_result",
          source: "recovery_heal",
          contentJson: JSON.stringify({
            tool_use_id: orphan.tool_use_id,
            content: HEAL_MARKER,
            is_error: true,
          }),
          status: "complete",
          ts: tsBase + 1,
          lastEventSeq: 0,
        });
        healedBlocks++;
      } catch (err) {
        logger.log("error", "dangling-tool-use-recovery.insert-error", {
          agent: agentName,
          tool_use_id: orphan.tool_use_id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Clear the session so the next turn forks fresh. Skip if it's
    // already null — that signals the operator already reset by hand.
    if (agent.sessionId) {
      try {
        await registry.clearSession(agentName);
      } catch (err) {
        logger.log("error", "dangling-tool-use-recovery.clear-session-error", {
          agent: agentName,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    healedAgents++;
  }

  logger.log("info", "dangling-tool-use-recovery.done", {
    healedAgents,
    healedBlocks,
    skippedAgents,
  });
}
