/**
 * Per-agent stall watchdog. Polls `live` every 30 seconds and flags any
 * working agent whose worker hasn't pinged in 90s.
 *
 * The worker emits `heartbeat` events during long tool calls (in addition
 * to all the regular events that update `lastHeartbeat`). Idle agents — i.e.
 * those waiting on mail — emit `status-change idle` and are excluded.
 *
 * If `config.watchdog.refork: true`, a stalled long-lived worker is
 * archived and respawned with `resume: sessionId` so it picks up where it
 * left off. Default behavior is observe-only — surface `agent_status:
 * stalled` and let the operator decide.
 */

import {
  loadConfig,
  resolveDaemonPort,
  resolveModelForRole,
  watchdogThresholdMs,
} from "@friday/shared";
import { randomUUID } from "node:crypto";
import { logger } from "../log.js";
import { buildSystemPrompt } from "../prompts/build-system-prompt.js";
import * as registry from "./registry.js";
import {
  dispatchTurn,
  forceWorkerRefork,
  liveAgentNames,
  peekLiveWorker,
  stallAgent,
} from "./lifecycle.js";
import { recordUserBlock } from "./block-injectors.js";

const TICK_INTERVAL_MS = 30_000;
// Per-agent-type stall thresholds live on `config.watchdog.thresholdsMs`
// (FIX_FORWARD 4.2) — see `watchdogThresholdMs` for resolution.

let interval: NodeJS.Timeout | null = null;
const flagged = new Set<string>();

export function startWatchdog(): NodeJS.Timeout {
  if (interval) return interval;
  interval = setInterval(tick, TICK_INTERVAL_MS);
  interval.unref();
  return interval;
}

export function stopWatchdog(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  flagged.clear();
}

function tick(): void {
  const now = Date.now();
  const cfg = loadConfig();
  const seen = new Set<string>();
  for (const name of liveAgentNames()) {
    seen.add(name);
    const w = peekLiveWorker(name);
    if (!w) continue;
    if (w.status !== "working") {
      // Idle (waiting on mail) — explicitly not a stall. Clear any prior flag.
      if (flagged.has(name)) {
        flagged.delete(name);
        logger.log("info", "watchdog.stall.cleared", { agent: name });
      }
      continue;
    }
    const sinceHb = now - w.lastHeartbeat;
    const thresholdMs = watchdogThresholdMs(cfg.watchdog, w.agentType);
    if (sinceHb > thresholdMs && !flagged.has(name)) {
      flagged.add(name);
      logger.log("warn", "watchdog.stall.detected", {
        agent: name,
        type: w.agentType,
        sinceHeartbeatMs: sinceHb,
        thresholdMs,
      });
      // FRI-145 M5: project `agents.status="stalled"` so the dashboard paints
      // the warn-colored dot. This restores the producer lost when the
      // `agent_status` SSE was retired (Phase 5) — `stalled` had consumers
      // (Sidebar / CommandPalette dots) but no daemon writer. V3: enqueued
      // fire-and-forget onto the agent-keyed Transition queue, NEVER awaited
      // inside this tick loop (awaiting would head-of-line-block the watchdog
      // across every agent). The Turn-state machine stays the sole
      // `registry.setStatus` writer — the watchdog does not write directly.
      void stallAgent(name).catch((err) => {
        logger.log("warn", "watchdog.stall.project.error", {
          agent: name,
          message: err instanceof Error ? err.message : String(err),
        });
      });

      if (cfg.watchdog?.refork) {
        // Fire-and-forget: refork awaits archiveAgent so the new fork can't
        // race the old worker's lingering exit handler (FIX_FORWARD 4.1).
        void refork(name).catch((err) => {
          logger.log("warn", "watchdog.refork.error", {
            agent: name,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }
  // Clear flags for agents that are no longer live (worker exited / killed).
  for (const flag of [...flagged]) {
    if (!seen.has(flag)) flagged.delete(flag);
  }
}

/**
 * Test seam (FRI-145 M5): drive a single watchdog tick synchronously and reset
 * the per-tick `flagged` dedup set. Lets the stalled-status regression test
 * exercise the REAL stall-detect → `stallAgent` enqueue path against a live
 * worker without waiting on the 30s interval. Not for production use.
 */
export function __tickForTest(): void {
  tick();
}
export function __resetFlaggedForTest(): void {
  flagged.clear();
}

async function refork(agentName: string): Promise<void> {
  const a = await registry.getAgent(agentName);
  if (!a) return;
  // Scheduled agents are one-shot — let them die naturally.
  if (a.type === "scheduled") return;

  logger.log("warn", "watchdog.refork", {
    agent: agentName,
    sessionId: a.sessionId ?? null,
  });

  // FIX_FORWARD 4.1: wait for the old worker to actually exit before
  // dispatching the replacement. Without this, the new fork sometimes
  // raced the dying worker's exit handler, which then live.delete()d
  // the *new* worker's slot.
  //
  // F4-B (FRI-4): `forceWorkerRefork` returns whatever prompts the user
  // had queued on the old worker's `nextPrompts`. Without this, the cheap
  // failure mode of "user typed a message while the previous turn was
  // hung; the worker died before the SDK saw it" silently drops their
  // message. Redispatch them on the fresh worker after the timeout
  // notice (or as the only payload if they're all we have).
  // Refork: tear down the hung worker without archiving the row — work
  // is continuing, the linked ticket (if any) must not be closed, and
  // the agent stays dispatchable for the replacement fork below.
  const drained = await forceWorkerRefork(agentName);

  const cfg = loadConfig();
  const { systemPrompt } = await buildSystemPrompt(a);
  const modelCfg = resolveModelForRole(cfg, a.type);

  // Empty prompt — the worker will idle and drain mail on its own (the long-
  // lived loop does this when no pendingPrompt is set… but we need to give
  // it *something* to chew on). Stub it with a self-instruction.
  const noticePrompt =
    "(Your previous turn timed out and was reforked. Check your mail inbox via mail_inbox if you were mid-task; otherwise wait for the next instruction.)";

  const workingDirectory = await registry.workingDirectoryFor(a);
  const dispatch = (prompt: string, turnId: string): void => {
    dispatchTurn({
      agentName,
      options: {
        agentName,
        agentType: a.type,
        workingDirectory,
        systemPrompt,
        prompt,
        turnId,
        model: modelCfg.name,
        thinking: modelCfg.thinking,
        effort: modelCfg.effort,
        resumeSessionId: a.sessionId ?? undefined,
        daemonPort: resolveDaemonPort(cfg),
        parentName: "parentName" in a ? (a.parentName ?? undefined) : undefined,
        mode: "long-lived",
      },
    });
  };

  // Always fork on the notice first so the user sees a turn marker for
  // the refork itself, then redeliver each drained prompt under its
  // original turn_id so the user-text block already in DB (recorded by
  // `recordUserBlock` at POST time) binds back to its assistant
  // response.
  const noticeTurnId = `t_${randomUUID()}`;
  // FRI-71: persist the notice as a user block so the refork's first
  // assistant reply renders against an originating bubble instead of
  // dangling orphan.
  try {
    await recordUserBlock({
      turnId: noticeTurnId,
      agentName,
      sessionId: a.sessionId ?? undefined,
      text: noticePrompt,
      source: "refork_notice",
    });
  } catch (err) {
    logger.log("warn", "watchdog.refork.user-block.error", {
      agent: agentName,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  dispatch(noticePrompt, noticeTurnId);
  if (drained.length > 0) {
    logger.log("info", "watchdog.refork.redeliver", {
      agent: agentName,
      count: drained.length,
    });
    for (const p of drained) {
      dispatch(p.prompt, p.turnId);
    }
  }
}
