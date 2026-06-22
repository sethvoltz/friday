/**
 * FRI-171 / ADR-047 — Intake Route-target executors (DAEMON-ONLY).
 *
 * Each executor wraps an EXISTING Friday primitive and returns a
 * {@link ResultReference} describing the artifact it created (whether it can be
 * undone, the human label for that inverse, and a deep-link). These run inside
 * the daemon process — they touch `upsertSchedule` / `insertCheckin` /
 * `saveEntry` / `createTicket` / `sendMail`, all node-side — and MUST NOT be
 * reachable from `packages/shared/src/sync/` (the client bundle). That boundary
 * is why the executor + its zod `payloadSchema` live here, not in @friday/shared.
 *
 * The TERMINAL-executor design (ADR-017): the router itself runs the action.
 * The orchestrator is just ONE more route target (`agent:<orchestrator>`)
 * reached by mail — there is no deferral-to-orchestrator-for-execution path.
 */

import { z } from "zod";
import { loadConfig, reminderDefaultHour } from "@friday/shared";
import { saveEntry } from "@friday/memory";
import { createTicket } from "@friday/shared/services";
import { sendMail } from "@friday/shared/services";
import { forgetEntry } from "@friday/memory";
import { upsertSchedule, deleteSchedule } from "../scheduler/scheduler.js";
import { insertCheckin, listHabits, deleteCheckin } from "../habits/store.js";
import { resolveRecipient, validateRecipient } from "../comms/recipient.js";

/**
 * A reference to the artifact an executor created. Drives the Inbox Done item's
 * Undo-vs-View CTA (`undoable` + `inverse_label`) and its deep-link.
 */
export interface ResultReference {
  /** True when the created artifact can be reversed (reminder/habit/memory). */
  undoable: boolean;
  /** Human label for the inverse, e.g. "Delete the reminder". Set iff undoable. */
  inverseLabel?: string;
  /** Deep-link to the created artifact (e.g. "/habits", "/tickets/FRI-12"). */
  deepLink: string;
}

/* ---------------- Core target payload schemas ---------------- */
// Authored here (daemon-side) alongside the executor, so a single module owns
// both the validation shape and the primitive call. The classifier is told to
// build a payload matching each target's schema (via the target `guidance`);
// the daemon re-validates before executing — a mismatch degrades to Proposed.

export const reminderPayloadSchema = z
  .object({
    text: z.string().min(1),
    /** Calendar day YYYY-MM-DD; fires at the configured default reminder hour. */
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

export const habitPayloadSchema = z
  .object({
    /** The habit name to check in (resolved to an id via listHabits). */
    habit: z.string().min(1),
  })
  .strict();

export const memoryPayloadSchema = z
  .object({
    text: z.string().min(1),
    title: z.string().min(1).optional(),
  })
  .strict();

export const ticketPayloadSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().optional(),
  })
  .strict();

/** Mail-contents payload — the shape for every `agent:<name>` target (apps +
 *  the orchestrator). The executor sends this as mail to the named agent. */
export const mailPayloadSchema = z
  .object({
    subject: z.string().optional(),
    body: z.string().min(1),
  })
  .strict();

/* ---------------- Core executors ---------------- */

/**
 * core:reminder — schedule a user-facing reminder via the shared `schedules`
 * table (kind='reminder'). Mirrors `reminder_create`'s dueDate→runAt resolution
 * (a bare YYYY-MM-DD fires at the configured default hour, in LOCAL time — never
 * `new Date("YYYY-MM-DD")`, which parses as UTC). Undoable: the user can delete
 * the reminder. deepLink → the schedules page.
 */
export async function executeReminder(payload: unknown): Promise<ResultReference> {
  const { text, dueDate } = reminderPayloadSchema.parse(payload);
  let runAt: string | undefined;
  if (dueDate) {
    const [y, mo, d] = dueDate.split("-").map(Number);
    const hour = reminderDefaultHour(loadConfig());
    runAt = new Date(y, mo - 1, d, hour, 0, 0, 0).toISOString();
  }
  const name = `intake_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await upsertSchedule({
    name,
    kind: "reminder",
    runAt,
    taskPrompt: text,
    deliveryJson: {
      channel: "chat",
      targetAgent: undefined,
      title: text,
      originatingAgent: loadConfig().orchestratorName,
    },
  });
  // The artifact id (the schedule `name`) rides in the deepLink as `?undo=` so
  // the Undo path can reverse it (`undoArtifact` parses it). The View deepLink
  // is still the schedules page.
  return {
    undoable: true,
    inverseLabel: "Delete the reminder",
    deepLink: `/schedules?undo=${encodeURIComponent(name)}`,
  };
}

/**
 * core:habit — append a Check-in to a habit resolved by NAME. There is no
 * lookup-by-name primitive, so we list habits and match (case-insensitive,
 * trimmed). An unresolved name throws — the dispatcher degrades that to a
 * Proposed item (never drops). Undoable: the Check-in can be undone. deepLink →
 * the habits page.
 */
export async function executeHabit(payload: unknown): Promise<ResultReference> {
  const { habit } = habitPayloadSchema.parse(payload);
  const wanted = habit.trim().toLowerCase();
  const habits = await listHabits("active");
  const match = habits.find((h) => h.name.trim().toLowerCase() === wanted);
  if (!match) {
    throw new Error(`no active habit named "${habit}"`);
  }
  const checkin = await insertCheckin(match.id);
  return {
    undoable: true,
    inverseLabel: "Undo the check-in",
    deepLink: `/habits?undo=${encodeURIComponent(checkin.id)}`,
  };
}

/**
 * core:memory — append a memory entry. The payload `text` becomes the content;
 * `title` is used if supplied, otherwise synthesized from the first line of the
 * cleaned text (capped). Undoable: the memory can be deleted. deepLink → the
 * memory page.
 */
export async function executeMemory(payload: unknown): Promise<ResultReference> {
  const { text, title } = memoryPayloadSchema.parse(payload);
  const nowIso = new Date().toISOString();
  const id = `intake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const synthTitle =
    (title ?? text.split("\n", 1)[0] ?? text).trim().slice(0, 80) || "Captured note";
  await saveEntry({
    id,
    title: synthTitle,
    content: text,
    tags: ["intake"],
    createdBy: "intake",
    createdAt: nowIso,
    updatedAt: nowIso,
    recallCount: 0,
    lastRecalledAt: null,
  });
  return {
    undoable: true,
    inverseLabel: "Delete the memory",
    deepLink: `/memory?undo=${encodeURIComponent(id)}`,
  };
}

/* ---------------- Inverse executor (Undo) ---------------- */

/**
 * Reverse the artifact a Done item created, dispatched on its `target_id`. The
 * artifact id is parsed from the Done row's `deep_link` `?undo=` param (the
 * undoable executors above stamp it). Only the three reversible core targets
 * are undoable; `core:ticket` and `agent:<name>` mail return `undoable:false`
 * and never reach here. Returns true if the artifact was found and removed
 * (idempotent: a second undo on an already-removed artifact returns false).
 *
 * DAEMON-ONLY — touches `deleteSchedule`/`deleteCheckin`/`forgetEntry`.
 */
export async function undoArtifact(targetId: string, deepLink: string): Promise<boolean> {
  const artifactId = parseUndoId(deepLink);
  if (!artifactId) return false;
  switch (targetId) {
    case "core:reminder":
      return await deleteSchedule(artifactId);
    case "core:habit":
      return await deleteCheckin(artifactId);
    case "core:memory":
      await forgetEntry(artifactId);
      return true;
    default:
      return false;
  }
}

/** Extract the `?undo=<artifactId>` token an undoable executor stamped into its
 *  deepLink. Returns null when the link carries no undo token. */
export function parseUndoId(deepLink: string): string | null {
  const q = deepLink.indexOf("?");
  if (q < 0) return null;
  const params = new URLSearchParams(deepLink.slice(q + 1));
  const id = params.get("undo");
  return id && id.length > 0 ? id : null;
}

/**
 * core:ticket — create a Friday-native ticket (NOT a Linear issue; Linear
 * creation is out of scope). Proposed-biased via the target guidance, so this
 * usually runs from an approve path rather than auto-acting. The artifact has an
 * id, so the deepLink is per-ticket. `undoable:false` — a ticket is content we
 * preserve, not an action we silently reverse (the user closes it on the
 * tickets page).
 */
export async function executeTicket(payload: unknown): Promise<ResultReference> {
  const { title, body } = ticketPayloadSchema.parse(payload);
  const ticket = await createTicket({ title, body });
  return { undoable: false, deepLink: `/tickets/${ticket.id}` };
}

/**
 * agent:<name> — route to an installed app's bare agent OR the orchestrator by
 * MAIL (ADR-017). Resolves + validates the recipient (the same sequence
 * `/api/mail/send` uses), then sends mail with the payload body. Mail is NOT
 * undoable (it has already been delivered); the deepLink points at the Mail
 * page with the created message selected.
 */
export function makeMailExecutor(agentName: string) {
  return async function executeMail(payload: unknown): Promise<ResultReference> {
    const { subject, body } = mailPayloadSchema.parse(payload);
    const fromAgent = loadConfig().orchestratorName;
    const resolved = await resolveRecipient(fromAgent, agentName);
    if (!resolved.ok) throw new Error(resolved.error);
    const check = await validateRecipient(resolved.agent);
    if (!check.ok) throw new Error(check.error);
    const mail = await sendMail({
      fromAgent,
      toAgent: check.agent,
      type: "task",
      subject,
      body,
    });
    return { undoable: false, deepLink: `/mail?id=${mail.id}` };
  };
}
