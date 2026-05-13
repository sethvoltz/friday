/**
 * Mail bridge. Subscribes to the in-process `mailBus` EventEmitter (fired by
 * `sendMail` in shared/services) and:
 *
 *  - Always publishes a `mail_delivered` SSE event so the dashboard sees the
 *    delivery in real time.
 *  - If the recipient currently has a live worker, sends a `mail-wakeup` IPC
 *    so the worker drains its inbox without polling.
 *  - If the recipient is registered but not live and is a long-lived type,
 *    spawns a fresh turn via `dispatchTurn` with `resume: sessionId` and a
 *    `buildMailPrompt` payload.
 *
 *  Scheduled and unknown agents are not auto-spawned — scheduled fires are
 *  driven by the cron tick, and unknown recipients are simply logged.
 */

import {
  composeSystemPrompt,
  loadConfig,
  normalizeModelConfig,
  readPromptStack,
} from "@friday/shared";
import { inbox, mailBus, type MailRow } from "@friday/shared/services";
import { eventBus } from "../events/bus.js";
import { logger } from "../log.js";
import {
  dispatchTurn,
  isAgentLive,
  recordUserBlock,
  wakeAgent,
  wakeAgentCritical,
} from "../agent/lifecycle.js";
import { wrapWithRecall } from "../agent/recall.js";
import * as registry from "../agent/registry.js";
import { randomUUID } from "node:crypto";
import { buildMailPrompt } from "./mail-prompt.js";

let started = false;

export function startMailBridge(): void {
  if (started) return;
  started = true;

  mailBus.on("mail:any", (row: MailRow) => {
    eventBus.publish({
      v: 1,
      type: "mail_delivered",
      mail_id: row.id,
      from: row.fromAgent,
      to: row.toAgent,
    });

    // Materialize the mail body as a user-role block in the recipient's chat
    // (FIX_FORWARD 1.2). The block carries `source='mail'` and the sender
    // name inside content_json so the dashboard can render attribution.
    try {
      const recipient = registry.getAgent(row.toAgent);
      recordUserBlock({
        turnId: `mail_${row.id}`,
        agentName: row.toAgent,
        sessionId: recipient?.sessionId ?? undefined,
        text: row.body,
        source: "mail",
        fromAgent: row.fromAgent,
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
        // FIX_FORWARD 2.4: critical mail triggers mid-turn injection (the
        // worker breaks at the next SDK iteration boundary). Normal mail
        // just wakes the worker so it drains at the outer query boundary
        // when idle.
        if (row.priority === "critical") {
          wakeAgentCritical(row.toAgent);
        } else {
          wakeAgent(row.toAgent);
        }
        return;
      }
      maybeSpawnFromMail(row.toAgent);
    } catch (err) {
      logger.log("warn", "mail.bridge.dispatch-error", {
        to: row.toAgent,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.log("info", "mail.bridge.started");
}

function maybeSpawnFromMail(agentName: string): void {
  const agentRow = registry.getAgent(agentName);
  if (!agentRow) {
    logger.log("debug", "mail.bridge.unknown-recipient", { agent: agentName });
    return;
  }
  // Scheduled agents are spawned by the cron tick, not by mail.
  if (agentRow.type === "scheduled") return;
  if (agentRow.status === "killed") {
    logger.log("debug", "mail.bridge.killed-recipient", { agent: agentName });
    return;
  }

  const pending = inbox(agentName);
  if (pending.length === 0) return;

  const cfg = loadConfig();
  const stack = readPromptStack(agentRow.type, []);
  const systemPrompt = composeSystemPrompt(stack);
  const modelCfg = normalizeModelConfig(cfg.model);
  const turnId = `t_${randomUUID()}`;

  // FIX_FORWARD 2.5: wrap with recall. Use the joined mail bodies as the
  // intent text so the memory query reflects what the recipient is being
  // asked to act on, not the surrounding mail-listing prose.
  const intent = pending.map((m) => m.body).join("\n\n");
  const mailPrompt = buildMailPrompt(agentName, pending);
  dispatchTurn({
    agentName,
    options: {
      agentName,
      agentType: agentRow.type,
      workingDirectory: registry.workingDirectoryFor(agentRow),
      systemPrompt,
      prompt: wrapWithRecall(intent, mailPrompt, "mail"),
      turnId,
      model: modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      resumeSessionId: agentRow.sessionId ?? undefined,
      daemonPort: cfg.daemonPort,
      parentName:
        "parentName" in agentRow ? agentRow.parentName ?? undefined : undefined,
      mode: "long-lived",
    },
  });
}
