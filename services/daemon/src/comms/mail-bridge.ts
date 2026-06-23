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

import { loadConfig, resolveDaemonPort, resolveModelForRole } from "@friday/shared";
import { inbox, isMailDeadLettered, mailBus, type MailRow } from "@friday/shared/services";
import { logger } from "../log.js";
import { dispatchTurn, isAgentLive, wakeAgent, wakeAgentCritical } from "../agent/lifecycle.js";
import { notify } from "../notifications/notify.js";
import { recordUserBlock } from "../agent/block-injectors.js";
import { buildDispatchPrompt } from "../prompts/build-dispatch-prompt.js";
import * as registry from "../agent/registry.js";
import { randomUUID } from "node:crypto";
import { buildMailPrompt } from "./mail-prompt.js";
import { cancelPendingRespawn } from "./respawn-orphan-mail.js";

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

      // FRI-142 / ADR-048 producer seam #4 — mail_delivered. Mail flowed
      // through the bridge. Scoped to ORCHESTRATOR-bound mail (the user's
      // chat): inter-agent internal mail is plumbing, not a user-facing event,
      // and the default policy is toast `present_only` / push `never` — so this
      // only ever raises a quiet in-app toast for a present user. A critical
      // mail carries `priority: "critical"` so it participates in DND bypass.
      if (row.toAgent === loadConfig().orchestratorName) {
        void notify({
          type: "mail_delivered",
          title: row.subject ? `Mail: ${row.subject}` : "New mail",
          body: `Mail from ${row.fromAgent}.`,
          deepLink: `/mail?id=${row.id}`,
          ...(row.priority === "critical" ? { priority: "critical" as const } : {}),
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

/**
 * Spawn a fresh turn for `agentName` driven by its current pending inbox.
 *
 * Exported (FRI-154) so the force-kill respawn path can re-enter the same
 * spawn surface without duplicating the inbox-read + prompt-build + dispatch
 * sequence. Idempotent against live workers (early-out via `isAgentLive` in
 * the caller; here we additionally early-out against an empty / fully-dead-
 * lettered inbox so a stale tracker fire is harmless).
 */
export async function maybeSpawnFromMail(agentName: string): Promise<void> {
  // FRI-154: the respawn timer may have raced a fresh-mail event that
  // already spawned a worker. The bridge's own caller checks `isAgentLive`
  // before invoking us; the respawn-timer caller does not — re-check here so
  // the respawn surface and the bridge surface are equally safe.
  if (isAgentLive(agentName)) {
    logger.log("debug", "mail.bridge.spawn.skip", { agent: agentName, reason: "agent-live" });
    return;
  }

  // Fresh mail (or respawn) supersedes a pending in-memory respawn timer.
  // Cancel here — if a timer was set, this code path is about to do its job.
  cancelPendingRespawn(agentName);

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

  // FRI-154: filter dead-lettered orphans. Once the anti-loop gate has
  // marked a row's `meta_json.dead_letter`, do NOT silently auto-resurrect
  // it on the next mail event. The row stays at `delivery='pending'` so the
  // operator can triage it; only the auto-spawn path skips it.
  const pending = (await inbox(agentName)).filter((m) => !isMailDeadLettered(m));
  if (pending.length === 0) return;

  const cfg = loadConfig();
  const modelCfg = resolveModelForRole(cfg, agentRow.type);
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
