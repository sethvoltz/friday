/**
 * Spawn one fire of a scheduled agent.
 *
 * Convention:
 *  - The scheduled agent's registry name == the schedule name. Each fire
 *    reuses the row so memory persists, but the SDK session is fresh per
 *    fire (the state.md file is the continuity boundary).
 *  - Forked worker runs in `mode: "one-shot"` — exits when the SDK query
 *    returns. No mail-drain loop, no idle wait.
 *  - On worker exit, we write last-run.md (timestamp / status / duration /
 *    sessionId) so the next fire's first-turn prompt has metadata.
 */

import { randomUUID } from "node:crypto";
import {
  composeSystemPrompt,
  loadConfig,
  normalizeModelConfig,
  readPromptStack,
  schema,
} from "@friday/shared";
import { logger } from "../log.js";
import { dispatchTurn, recordUserBlock } from "../agent/lifecycle.js";
import { wrapWithRecall } from "../agent/recall.js";
import * as registry from "../agent/registry.js";
import {
  buildFirstTurnWithState,
  ensureScheduleStateDir,
  scheduleStateDir,
  writeLastRun,
} from "./state.js";

export function spawnScheduledRun(
  scheduleRow: typeof schema.schedules.$inferSelect,
  runId: string,
): void {
  const cfg = loadConfig();
  const stateDir = ensureScheduleStateDir(scheduleRow.name);

  // Ensure the registry has a row for this scheduled agent.
  if (!registry.getAgent(scheduleRow.name)) {
    registry.registerAgent({
      name: scheduleRow.name,
      type: "scheduled",
    });
  }

  const stack = readPromptStack("scheduled", []);
  const systemPrompt = composeSystemPrompt(stack, {
    agentName: scheduleRow.name,
    agentType: "scheduled",
  });
  const modelCfg = normalizeModelConfig(cfg.model);

  // FIX_FORWARD 2.5: wrap with recall against the raw task prompt — the
  // first-turn template adds state-injection scaffolding that would noise
  // the memory query otherwise.
  const promptBody = buildFirstTurnWithState({
    scheduleName: scheduleRow.name,
    taskPrompt: scheduleRow.taskPrompt,
  });
  const prompt = wrapWithRecall(
    scheduleRow.taskPrompt,
    promptBody,
    "scheduled",
  );

  const turnId = `t_${randomUUID()}`;

  logger.log("info", "schedule.spawn", {
    schedule: scheduleRow.name,
    runId,
    turnId,
    stateDir,
  });

  // FRI-71: persist the task prompt as a user block so the scheduled run's
  // first turn renders with the originating user bubble. Per-fire session
  // ids are fresh — recordUserBlock falls back to '__pending__' until
  // post-turn JSONL recovery rewrites with the SDK-assigned id.
  try {
    recordUserBlock({
      turnId,
      agentName: scheduleRow.name,
      text: scheduleRow.taskPrompt,
      source: "schedule",
    });
  } catch (err) {
    logger.log("warn", "schedule.user-block.error", {
      schedule: scheduleRow.name,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  dispatchTurn({
    agentName: scheduleRow.name,
    onExit: (info) => {
      try {
        writeLastRun(scheduleRow.name, {
          timestamp: new Date().toISOString(),
          status: info.status,
          durationMs: info.durationMs,
          sessionId: info.sessionId,
        });
      } catch (err) {
        logger.log("warn", "schedule.last-run.write-error", {
          schedule: scheduleRow.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    options: {
      agentName: scheduleRow.name,
      agentType: "scheduled",
      workingDirectory: process.cwd(),
      systemPrompt,
      prompt,
      turnId,
      model: modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      daemonPort: cfg.daemonPort,
      stateDir: scheduleStateDir(scheduleRow.name),
      mode: "one-shot",
    },
  });
}
