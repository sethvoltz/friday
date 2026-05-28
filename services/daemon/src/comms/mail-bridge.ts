/**
 * Mail bridge. Subscribes to the in-process `mailBus` EventEmitter (fired by
 * `sendMail` in shared/services) and:
 *
 *  - Phase 5: the legacy `mail_delivered` SSE event is retired; the dashboard
 *    reads the `mail` slice reactively via Zero, so delivery is visible
 *    without an SSE-triggered nudge.
 *  - If the recipient currently has a live worker, sends a `mail-wakeup` IPC
 *    so the worker drains its inbox without polling.
 *  - If the recipient is registered but not live and is a long-lived type,
 *    spawns a fresh turn via `dispatchTurn` with `resume: sessionId` and a
 *    `buildMailPrompt` payload.
 *
 *  Scheduled and unknown agents are not auto-spawned — scheduled fires are
 *  driven by the cron tick, and unknown recipients are simply logged.
 */

import { loadConfig, normalizeModelConfig, resolveDaemonPort } from "@friday/shared";
import { inbox, mailBus, type MailRow } from "@friday/shared/services";
import { logger } from "../log.js";
import {
  dispatchTurn,
  isAgentLive,
  recordUserBlock,
  wakeAgent,
  wakeAgentCritical,
} from "../agent/lifecycle.js";
import { buildDispatchPrompt } from "../prompts/build-dispatch-prompt.js";
import * as registry from "../agent/registry.js";
import { randomUUID } from "node:crypto";
import { buildMailPrompt } from "./mail-prompt.js";

let started = false;

export function startMailBridge(): void {
  if (started) return;
  started = true;

  mailBus.on("mail:any", (row: MailRow) => {
    // The handler is fire-and-forget — mailBus is a sync EventEmitter, and
    // shared/services moves to async under ADR-023. We spawn an IIFE so
    // any rejection lands on the bus's `error` channel rather than as an
    // unhandled promise.
    void (async () => {
      // Phase 5: `mail_delivered` SSE retired — Zero replicates the
      // `mail` slice (Phase 3.6) so the dashboard sees the new row
      // through its reactive query.
      try {
        const recipient = await registry.getAgent(row.toAgent);
        await recordUserBlock({
          turnId: `mail_${row.id}`,
          agentName: row.toAgent,
          sessionId: recipient?.sessionId ?? undefined,
          text: row.body,
          source: "mail",
          fromAgent: row.fromAgent,
          mailMeta: {
            id: row.id,
            subject: row.subject,
            type: row.type,
            priority: row.priority,
            threadId: row.threadId,
            ts: row.ts,
          },
        });
      } catch (err) {
        logger.log("warn", "mail.bridge.user-block.error", {
          to: row.toAgent,
          mailId: row.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        if (isAgentLive(row.toAgent)) {
          if (row.priority === "critical") {
            wakeAgentCritical(row.toAgent);
          } else {
            wakeAgent(row.toAgent);
          }
          return;
        }
        await maybeSpawnFromMail(row.toAgent);
      } catch (err) {
        logger.log("warn", "mail.bridge.dispatch-error", {
          to: row.toAgent,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  logger.log("info", "mail.bridge.started");
}

async function maybeSpawnFromMail(agentName: string): Promise<void> {
  const agentRow = await registry.getAgent(agentName);
  if (!agentRow) {
    logger.log("debug", "mail.bridge.unknown-recipient", { agent: agentName });
    return;
  }
  // Scheduled agents are spawned by the cron tick, not by mail.
  if (agentRow.type === "scheduled") return;
  if (agentRow.status === "archived") {
    logger.log("debug", "mail.bridge.archived-recipient", { agent: agentName });
    return;
  }

  const pending = await inbox(agentName);
  if (pending.length === 0) return;

  const cfg = loadConfig();
  const modelCfg = normalizeModelConfig(cfg.model);
  const turnId = `t_${randomUUID()}`;

  // Use the joined mail bodies as the intent text so the memory query
  // reflects what the recipient is being asked to act on, not the
  // surrounding mail-listing prose.
  const intent = pending.map((m) => m.body).join("\n\n");
  const mailPrompt = buildMailPrompt(agentName, pending);
  const { body: wrappedPrompt, systemPrompt: dispatchSystemPrompt } = await buildDispatchPrompt(
    agentRow,
    { kind: "mail", body: mailPrompt, intentText: intent },
  );
  const workingDirectory = await registry.workingDirectoryFor(agentRow);
  dispatchTurn({
    agentName,
    options: {
      agentName,
      agentType: agentRow.type,
      workingDirectory,
      systemPrompt: dispatchSystemPrompt,
      prompt: wrappedPrompt,
      turnId,
      model: modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      resumeSessionId: agentRow.sessionId ?? undefined,
      daemonPort: resolveDaemonPort(cfg),
      parentName: "parentName" in agentRow ? (agentRow.parentName ?? undefined) : undefined,
      mode: "long-lived",
    },
  });
}
