/**
 * Per-agent stall watchdog. Polls `live` every 30 seconds and flags any
 * working agent whose worker hasn't pinged in 90s.
 *
 * The worker emits `heartbeat` events during long tool calls (in addition
 * to all the regular events that update `lastHeartbeat`). Idle agents — i.e.
 * those waiting on mail — emit `status-change idle` and are excluded.
 *
 * If `config.watchdog.refork: true`, a stalled long-lived worker is killed
 * and respawned with `resume: sessionId` so it picks up where it left off.
 * Default behavior is observe-only — surface `agent_status: stalled` and
 * let the operator decide.
 */

import {
  composeSystemPrompt,
  loadConfig,
  normalizeModelConfig,
  readPromptStack,
} from "@friday/shared";
import { randomUUID } from "node:crypto";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import * as registry from "./registry.js";
import {
  dispatchTurn,
  killAgent,
  liveAgentNames,
  peekLiveWorker,
} from "./lifecycle.js";

const TICK_INTERVAL_MS = 30_000;
const STALL_THRESHOLD_MS = 90_000;

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
    if (sinceHb > STALL_THRESHOLD_MS && !flagged.has(name)) {
      flagged.add(name);
      logger.log("warn", "watchdog.stall.detected", {
        agent: name,
        sinceHeartbeatMs: sinceHb,
      });
      eventBus.publish({
        v: 1,
        type: "agent_status",
        agent: name,
        status: "stalled",
        since: now,
      });

      const cfg = loadConfig();
      if (cfg.watchdog?.refork) {
        try {
          refork(name);
        } catch (err) {
          logger.log("warn", "watchdog.refork.error", {
            agent: name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
  // Clear flags for agents that are no longer live (worker exited / killed).
  for (const flag of [...flagged]) {
    if (!seen.has(flag)) flagged.delete(flag);
  }
}

function refork(agentName: string): void {
  const a = registry.getAgent(agentName);
  if (!a) return;
  // Scheduled agents are one-shot — let them die naturally.
  if (a.type === "scheduled") return;

  logger.log("warn", "watchdog.refork", {
    agent: agentName,
    sessionId: a.sessionId ?? null,
  });

  killAgent(agentName);

  const cfg = loadConfig();
  const stack = readPromptStack(a.type, []);
  const systemPrompt = composeSystemPrompt(stack);
  const modelCfg = normalizeModelConfig(cfg.model);

  // Empty prompt — the worker will idle and drain mail on its own (the long-
  // lived loop does this when no pendingPrompt is set… but we need to give
  // it *something* to chew on). Stub it with a self-instruction.
  const prompt =
    "(Your previous turn timed out and was reforked. Check your mail inbox via mail_inbox if you were mid-task; otherwise wait for the next instruction.)";

  dispatchTurn({
    agentName,
    options: {
      agentName,
      agentType: a.type,
      workingDirectory: process.cwd(),
      systemPrompt,
      prompt,
      turnId: `t_${randomUUID()}`,
      model: modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      resumeSessionId: a.sessionId ?? undefined,
      daemonPort: cfg.daemonPort,
      parentName:
        "parentName" in a ? a.parentName ?? undefined : undefined,
      mode: "long-lived",
    },
  });
}
