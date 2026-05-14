/**
 * Continuous invariant auditor. Boot recovery reconciles drift at
 * startup, but state can also diverge mid-run — a filesystem write
 * deletes a worktree out from under us, a worker crashes without firing
 * its exit handler, an SSE replay confuses the dashboard's local model
 * (PR D). Boot-only healing means "wait until next restart"; this
 * auditor catches it within `AUDIT_INTERVAL_MS` and self-corrects.
 *
 * Each tick checks every registered agent for known impossible states.
 * The single source of truth for each invariant is named explicitly in
 * the rule so future contributors don't have to guess which side wins.
 *
 * Cheap by design: read-only over the agent list, file-existence stats,
 * one in-memory Map lookup per agent. Safe to run every minute even on
 * a cold laptop.
 */

import { existsSync } from "node:fs";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import * as registry from "./registry.js";
import { isAgentLive } from "./lifecycle.js";

const AUDIT_INTERVAL_MS = 60_000;

let interval: NodeJS.Timeout | undefined;

/**
 * Start the auditor. Idempotent — calling twice is a no-op.
 *
 * Source-of-truth rules currently checked:
 *
 * 1. **Builder worktree presence** — for any builder whose `worktreePath`
 *    is set: the dir must exist OR the agent must be archived. The
 *    filesystem is authoritative. A builder without a worktree can't
 *    run another turn (the SDK's cwd would be missing), so this is an
 *    impossible state and we archive instead of letting it leak into
 *    mail-recovery dispatches.
 *
 * 2. **`status=working` ⇒ live map has the agent** — the live worker
 *    map is authoritative for runtime status. A row marked working
 *    without a corresponding worker is a zombie; demote to idle so the
 *    sidebar reads truthfully and the next dispatch forks fresh.
 *
 * Add new invariants here as we identify drift modes. Each rule should
 * be cheap, idempotent, and name its source of truth in a comment so
 * the reader doesn't have to guess.
 */
export function startInvariantAuditor(): NodeJS.Timeout | undefined {
  if (interval) return interval;
  interval = setInterval(audit, AUDIT_INTERVAL_MS);
  interval.unref();
  // Run one pass synchronously at start so we don't have to wait the
  // full interval after a restart to catch boot-recovery's blind spots.
  audit();
  return interval;
}

export function stopInvariantAuditor(): void {
  if (interval) {
    clearInterval(interval);
    interval = undefined;
  }
}

/**
 * One audit pass. Exported for testability — tests drive `audit()`
 * directly instead of waiting on the interval.
 */
export function audit(): { archived: string[]; demoted: string[] } {
  const archived: string[] = [];
  const demoted: string[] = [];
  for (const a of registry.listAgents()) {
    // Rule 1: builder worktree presence. Filesystem is the source of
    // truth — if the dir is gone, the agent can't function and the
    // registry row was lying.
    if (
      a.type === "builder" &&
      a.status !== "archived" &&
      "worktreePath" in a &&
      a.worktreePath &&
      !existsSync(a.worktreePath)
    ) {
      logger.log("warn", "invariant.archive-orphan", {
        agent: a.name,
        worktreePath: a.worktreePath,
        previousStatus: a.status,
      });
      registry.archiveAgent(a.name);
      eventBus.publish({
        v: 1,
        type: "agent_lifecycle",
        agent: a.name,
        agentType: a.type,
        event: "archive",
        reason: "orphan-worktree",
      });
      archived.push(a.name);
      continue;
    }

    // Rule 2: working ⇒ live. The live worker map is the source of
    // truth for runtime activity. A row marked working with no worker
    // is a zombie. Demote to idle so the next dispatch forks fresh
    // instead of trying to send a `prompt` IPC to a non-existent child.
    if (a.status === "working" && !isAgentLive(a.name)) {
      logger.log("warn", "invariant.demote-zombie-working", {
        agent: a.name,
      });
      registry.setStatus(a.name, "idle");
      eventBus.publish({
        v: 1,
        type: "agent_status",
        agent: a.name,
        status: "idle",
        since: Date.now(),
      });
      demoted.push(a.name);
    }
  }
  if (archived.length || demoted.length) {
    logger.log("info", "invariant.audit.summary", {
      archived,
      demoted,
    });
  }
  return { archived, demoted };
}
