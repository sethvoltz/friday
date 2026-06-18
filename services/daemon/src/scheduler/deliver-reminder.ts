import { loadConfig, schema } from "@friday/shared";
import { recordUserBlock } from "../agent/block-injectors.js";
import { logger } from "../log.js";

/** Payload stored in schedules.delivery_json for kind='reminder' rows. */
export interface ReminderDelivery {
  /** Currently always "chat". Reserved for FRI-142 push as a future channel. */
  channel?: string;
  /** Whose chat the reminder lands in. Defaults to the orchestrator ("friday"). */
  targetAgent?: string;
  title: string;
  body?: string;
  /** Reserved for a future deep-link into the originating agent's context. */
  deepLink?: string;
  /** The agent that created the reminder (e.g. "kitchen"). */
  originatingAgent?: string;
}

/**
 * Deliver a fired reminder as a user-facing chat block WITHOUT waking any agent.
 * Writes a role:"user", source:"reminder" block into the target (default
 * orchestrator) chat via recordUserBlock and stops. Deliberately does NOT call
 * dispatchTurn / spawnScheduledRun / wakeAgent / wakeAgentCritical /
 * maybeSpawnFromMail — that is the entire point of a reminder.
 */
export async function deliverReminder(
  r: typeof schema.schedules.$inferSelect,
  runId: string,
): Promise<void> {
  const delivery = (r.deliveryJson ?? {}) as ReminderDelivery;
  const agentName = delivery.targetAgent ?? loadConfig().orchestratorName;
  const title = delivery.title ?? r.taskPrompt;
  const text = delivery.body ? `${title}\n\n${delivery.body}` : title;
  await recordUserBlock({
    turnId: `reminder_${runId}`,
    agentName,
    text,
    source: "reminder",
    // FRI-168: stamp the originating schedule name so the delivered block
    // carries its identity for ack/snooze.
    reminderName: r.name,
  });
  logger.log("info", "reminder.delivered", {
    name: r.name,
    runId,
    agentName,
    originatingAgent: delivery.originatingAgent ?? null,
  });
}
