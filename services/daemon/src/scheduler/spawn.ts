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
import { loadConfig, resolveDaemonPort, resolveModelForRole, schema } from "@friday/shared";
import { logger } from "../log.js";
import { dispatchTurn } from "../agent/lifecycle.js";
import { notify } from "../notifications/notify.js";
import { recordUserBlock } from "../agent/block-injectors.js";
import { buildDispatchPrompt } from "../prompts/build-dispatch-prompt.js";
import * as registry from "../agent/registry.js";
import {
  buildFirstTurnWithState,
  ensureScheduleStateDir,
  scheduleStateDir,
  writeLastRun,
} from "./state.js";
import { closeScheduleRun } from "./runs.js";

export async function spawnScheduledRun(
  scheduleRow: typeof schema.schedules.$inferSelect,
  runId: string,
  // ADR-024: the `schedule_runs` row opened by fireSchedule. The worker is
  // fire-and-forget, so we transition this row to a terminal status from the
  // onExit callback when the worker actually finishes. Null when the open
  // insert failed (recording is best-effort and never blocks a fire).
  runRowId: number | null = null,
): Promise<void> {
  const cfg = loadConfig();
  const stateDir = ensureScheduleStateDir(scheduleRow.name);

  // Ensure the registry has a row for this scheduled agent.
  if (!(await registry.getAgent(scheduleRow.name))) {
    await registry.registerAgent({
      name: scheduleRow.name,
      type: "scheduled",
    });
  }

  const modelCfg = resolveModelForRole(cfg, "scheduled");

  // Use the raw task prompt as recall intent — the first-turn template
  // adds state-injection scaffolding that would noise the memory query
  // otherwise.
  const promptBody = buildFirstTurnWithState({
    scheduleName: scheduleRow.name,
    taskPrompt: scheduleRow.taskPrompt,
  });
  const { body: prompt, systemPrompt: dispatchSystemPrompt } = await buildDispatchPrompt(
    { name: scheduleRow.name, type: "scheduled" },
    { kind: "scheduled", body: promptBody, intentText: scheduleRow.taskPrompt },
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
    await recordUserBlock({
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
    // ADR-024 leak backstop: the worker is fire-and-forget, so a throw during
    // the async spawn setup (before `child.on("exit")` is wired) is swallowed
    // by dispatchTurn and `onExit` never runs. Close the run row `error` here
    // so it doesn't leak `running` forever. Best-effort.
    onSpawnError: (err) => {
      void closeScheduleRun(runRowId, "error", err instanceof Error ? err.message : String(err));
    },
    onExit: (info) => {
      // ADR-024: transition the schedule_runs row to a terminal status now
      // that the worker has actually exited. A clean exit closes `complete`;
      // an `error` exit closes `error` with an explanatory message; an
      // `aborted` exit (user Stop / stall-kill) is NOT a failure but the
      // schema's status check allows only running|complete|error — so we
      // record it as `error` with the distinct, explanatory message
      // `"aborted"` rather than a bare "failure with no reason". Fire-and-
      // forget — closeScheduleRun is best-effort and swallows its own failures.
      const closeStatus = info.status === "complete" ? "complete" : "error";
      const closeError =
        info.status === "error"
          ? "worker exited with error"
          : info.status === "aborted"
            ? "aborted"
            : undefined;
      void closeScheduleRun(runRowId, closeStatus, closeError);
      // FRI-142 / ADR-048 producer seam #3 — schedule_fired. A scheduled agent
      // surfaced a result. Fire-and-forget on a CLEAN completion only (an
      // error/aborted run is daemon-internal churn, not a user-facing result).
      if (info.status === "complete") {
        void notify({
          type: "schedule_fired",
          title: "A scheduled agent finished",
          body: `${scheduleRow.name} completed its run.`,
          deepLink: `/agents/${encodeURIComponent(scheduleRow.name)}`,
        });
      }
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
      systemPrompt: dispatchSystemPrompt,
      prompt,
      turnId,
      model: modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      daemonPort: resolveDaemonPort(cfg),
      stateDir: scheduleStateDir(scheduleRow.name),
      mode: "one-shot",
    },
  });
}
