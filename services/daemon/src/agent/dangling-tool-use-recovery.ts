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
 * The heal (post-FRI-89): we resolve the dangling `tool_use` in both
 * surfaces the SDK and the dashboard read from, **without resetting
 * the session**. Continuity is Friday's load-bearing property — the
 * only paths permitted to clear `agents.session_id` are user-driven
 * `/clear` and app-reinstall-without-`--adopt`. Boot recovery must
 * never violate that.
 *
 *  1. Insert a synthetic `tool_result` block in Postgres marking
 *     the tool as interrupted. The dashboard renders it, so the
 *     operator sees what happened without having to read a log.
 *  2. Append a matching `tool_result` line to the SDK's session
 *     transcript at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 *     so the next dispatched turn resumes the same session cleanly
 *     instead of forking a fresh one.
 *
 * Scoping rules:
 *  - Only tool_uses whose `session_id` matches the agent's *current*
 *    `agents.session_id` are considered live. Stale tool_uses from
 *    sessions long since cleared (by `/clear` or app reinstall) are
 *    inert — they have no SDK transcript referencing them, and treating
 *    them as live caused the FRI-89 fragmentation bug (a brew restart
 *    would "heal" the orchestrator's healthy session because the query
 *    spotted a tool_use from a prior cleared session).
 *  - Agents with `session_id IS NULL` are skipped: no live session to
 *    fix.
 *  - Archived agents are skipped: no one will dispatch a turn against
 *    them, so the dangling state is inert.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@friday/shared";
import { insertBlock } from "@friday/shared/services";
import * as registry from "./registry.js";
import { workingDirectoryFor } from "./registry.js";
import { healDanglingToolUseInJsonl } from "./sdk-jsonl-heal.js";
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
  "[Tool call interrupted by daemon restart. Session continues; this tool is marked as an error so the conversation can pick up from the next message.]";

export async function recoverDanglingToolUses(): Promise<void> {
  const db = getDb();
  // Find every `tool_use` block whose `tool_use_id` has no matching
  // `tool_result` block AND whose session_id matches the agent's
  // current live session. The agent join filters out:
  //  - agents with no current session (`/clear`'d or never run)
  //  - tool_uses from prior sessions (inert; can't be resumed)
  // Archived agents are filtered in code below so the skip count
  // still surfaces in logs.
  const result = await db.execute<DanglingToolUseRow>(sql`
    SELECT
      b.agent_name,
      b.turn_id,
      b.session_id,
      (b.content_json->>'tool_use_id') AS tool_use_id,
      b.ts
    FROM blocks b
    JOIN agents a ON a.name = b.agent_name
    WHERE b.kind = 'tool_use'
      AND b.content_json->>'tool_use_id' IS NOT NULL
      AND a.session_id IS NOT NULL
      AND b.session_id = a.session_id
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
    : ((result as { rows: DanglingToolUseRow[] }).rows ?? []);

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
  let jsonlAppends = 0;
  let jsonlSkips = 0;
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

    const cwd = await workingDirectoryFor(agent);

    // Resolve each dangling tool_use in both surfaces:
    //   - Postgres: synthetic `tool_result` block so the dashboard
    //     renders the interrupt marker in the chat stream.
    //   - SDK JSONL transcript: matching tool_result line so the next
    //     dispatched turn can `resume:` the same session without
    //     Claude rejecting the conversation.
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
        });
        healedBlocks++;
      } catch (err) {
        logger.log("error", "dangling-tool-use-recovery.insert-error", {
          agent: agentName,
          tool_use_id: orphan.tool_use_id,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const jsonl = healDanglingToolUseInJsonl({
          cwd,
          sessionId: orphan.session_id,
          toolUseId: orphan.tool_use_id,
          healMarker: HEAL_MARKER,
        });
        if (jsonl.written) {
          jsonlAppends++;
        } else {
          jsonlSkips++;
          logger.log("info", "dangling-tool-use-recovery.jsonl-skip", {
            agent: agentName,
            tool_use_id: orphan.tool_use_id,
            reason: jsonl.reason,
            path: jsonl.path,
          });
        }
      } catch (err) {
        logger.log("error", "dangling-tool-use-recovery.jsonl-error", {
          agent: agentName,
          tool_use_id: orphan.tool_use_id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    healedAgents++;
  }

  logger.log("info", "dangling-tool-use-recovery.done", {
    healedAgents,
    healedBlocks,
    jsonlAppends,
    jsonlSkips,
    skippedAgents,
  });
}
