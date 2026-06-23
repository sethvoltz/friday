/**
 * FRI-171 / ADR-047 — Intake routing-target registry (DAEMON-ONLY).
 *
 * Assembles, AT CALL TIME, the set of Route targets the classifier may pick
 * from for a single Capture:
 *   - the four code-owned CORE targets (reminder / habit / memory / ticket),
 *     baked here with guidance prose + a zod payloadSchema + an executor;
 *   - one `agent:<name>` target per installed app's manifest `intakeRoutes[]`
 *     (guidance = the app's `describe` string, executor = mail to that agent);
 *   - one `agent:<orchestrator>` target so the orchestrator is reachable by
 *     mail — it is just another route target (ADR-017), never a special
 *     execution-deferral path.
 *
 * This module is DAEMON-SIDE: the executors + zod schemas touch node-only
 * primitives (scheduler / habits / memory / tickets / mail) and the registry is
 * never imported from `packages/shared/src/sync/` (the client bundle).
 *
 * FRI-142 / ADR-048 (Layer 3): the `target_id → executor` resolution now lives
 * in the producer-agnostic `inbox/route-registry.ts`. This module is Intake's
 * CONTRIBUTOR to that registry: `registerIntakeTargets()` registers the static
 * core targets + a dynamic provider for the app/orchestrator mail targets, so a
 * non-Intake producer's target resolves through the same registry with no
 * further refactor. `assembleRegistry()` (the classifier's call-time view) is
 * preserved as a thin alias over the producer-agnostic assemble.
 */

import { loadConfig } from "@friday/shared";
import type { RouteTargetId } from "@friday/shared";
import { listApps, inspectApp } from "../apps/installer.js";
import {
  registerTargets,
  registerTargetProvider,
  assembleAllTargets,
  type RouteTarget as GenericRouteTarget,
} from "../inbox/route-registry.js";
import {
  executeReminder,
  executeHabit,
  executeMemory,
  executeTicket,
  makeMailExecutor,
  undoArtifact,
  reminderPayloadSchema,
  habitPayloadSchema,
  memoryPayloadSchema,
  ticketPayloadSchema,
  mailPayloadSchema,
} from "./executors.js";

/**
 * A single Route target the classifier may pick. Intake's view narrows the
 * producer-agnostic {@link GenericRouteTarget}'s `id` to a `RouteTargetId` (the
 * Intake taxonomy) for the verdict shape. Structurally identical — the narrow
 * `id` is assignable to the generic `string` id, so an Intake target IS a
 * producer-agnostic target.
 */
export interface RouteTarget extends GenericRouteTarget {
  id: RouteTargetId;
}

/** The four code-owned core targets. Guidance prose is authored here — it (plus
 *  the Intake persona) is the routing-quality tuning lever. Each core target
 *  carries its forward executor AND its inverse (`undo`) so the producer-
 *  agnostic registry can reverse a Done item without an Intake-keyed switch. */
export function coreTargets(): RouteTarget[] {
  return [
    {
      id: "core:reminder",
      guidance:
        'Route here for a time-anchored nudge the user wants delivered later (e.g. "remind me to thaw the chicken Thursday", "ping me about the dentist next week"). payload: { text: string; dueDate?: "YYYY-MM-DD" }. Use dueDate ONLY when the Capture names a calendar day with no clock time. A reminder is reversible and low-stakes — act when confident.',
      payloadSchema: reminderPayloadSchema,
      execute: executeReminder,
      undo: (deepLink: string) => undoArtifact("core:reminder", deepLink),
    },
    {
      id: "core:habit",
      guidance:
        'Route here ONLY when the Capture clearly logs completion of a tracked habit ("did my pushups", "meditated today"). payload: { habit: string } where `habit` is the habit name to check in. If you are not sure a matching habit exists, leave Unsorted. A check-in is reversible — act when confident.',
      payloadSchema: habitPayloadSchema,
      execute: executeHabit,
      undo: (deepLink: string) => undoArtifact("core:habit", deepLink),
    },
    {
      id: "core:memory",
      guidance:
        'Route here for a durable fact, preference, or piece of context the user wants Friday to remember ("I prefer morning meetings", "my wifi password is X"). payload: { text: string; title?: string }. Saving a memory is reversible and low-stakes — act when confident.',
      payloadSchema: memoryPayloadSchema,
      execute: executeMemory,
      undo: (deepLink: string) => undoArtifact("core:memory", deepLink),
    },
    {
      id: "core:ticket",
      guidance:
        'Route here for a unit of work to track ("fix the leaky faucet", "follow up with the contractor"). payload: { title: string; body?: string }. A ticket is higher-stakes — prefer disposition "propose" so the user confirms before it is created.',
      payloadSchema: ticketPayloadSchema,
      execute: executeTicket,
      // No `undo` — a ticket is content we preserve, not an action we reverse.
    },
  ];
}

/** Build an `agent:<name>` mail target with the given guidance. Used for both
 *  app intake routes and the orchestrator. Mail is not reversible (a sent mail
 *  can't be recalled) — no `undo`; the Done CTA is View. */
function mailTarget(agentName: string, guidance: string): RouteTarget {
  return {
    id: `agent:${agentName}`,
    guidance,
    payloadSchema: mailPayloadSchema,
    execute: makeMailExecutor(agentName),
  };
}

/**
 * Enumerate every installed app's manifest `intakeRoutes[]` and turn each into
 * an `agent:<name>` mail target. Defensive: a malformed/absent manifest or
 * missing intakeRoutes degrades to no targets for that app rather than throwing
 * (a bad app must not break intake for the rest).
 */
async function appTargets(): Promise<RouteTarget[]> {
  const out: RouteTarget[] = [];
  const apps = await listApps();
  for (const app of apps) {
    if (app.status !== "installed") continue;
    const inspection = await inspectApp(app.id);
    const routes = inspection?.manifest.intakeRoutes ?? [];
    for (const r of routes) {
      out.push(
        mailTarget(
          r.agent,
          `Route here to hand this Capture to the "${r.agent}" app agent by mail. ${r.describe} payload: { subject?: string; body: string } — body is the message contents. Mail is higher-stakes (it reaches another agent) — prefer disposition "propose".`,
        ),
      );
    }
  }
  return out;
}

/** Build the orchestrator mail target (the mail catch-all). */
function orchestratorTarget(): RouteTarget {
  const orchestratorName = loadConfig().orchestratorName;
  return mailTarget(
    orchestratorName,
    `Route here to send this Capture to the orchestrator ("${orchestratorName}") as mail — the catch-all when the Capture belongs in the user's main conversation but fits no core or app target. payload: { subject?: string; body: string }. Mail to the orchestrator is higher-stakes — prefer disposition "propose".`,
  );
}

/** The dynamic provider Intake contributes to the producer-agnostic registry:
 *  the app intake-route targets + the orchestrator mail target, re-evaluated at
 *  call time because the installed-app set changes at runtime. */
async function intakeDynamicTargets(): Promise<GenericRouteTarget[]> {
  const apps = await appTargets();
  return [...apps, orchestratorTarget()];
}

let registered = false;

/**
 * Register Intake's targets into the producer-agnostic registry. Idempotent —
 * called once at daemon startup (and harmlessly a second time in tests). The
 * core targets register statically; the app/orchestrator mail targets register
 * as a dynamic provider (runtime-dependent set).
 */
export function registerIntakeTargets(): void {
  if (registered) return;
  registered = true;
  registerTargets(coreTargets());
  registerTargetProvider(intakeDynamicTargets);
}

/**
 * Assemble the full Route-target registry for one Capture, at call time:
 * core targets + app intake-route targets + the orchestrator mail target.
 *
 * Now a thin alias over the producer-agnostic `assembleAllTargets()` — it
 * returns whatever is registered (core + Intake's dynamic provider, plus any
 * non-Intake producer's targets), so the classifier's menu and the action-
 * resolution path read from the SAME source of truth. Self-registers on first
 * call so a caller that hasn't run boot wiring (a test) still gets the targets.
 */
export async function assembleRegistry(): Promise<RouteTarget[]> {
  registerIntakeTargets();
  // The classifier only routes to Intake-id targets; the generic set is a
  // structural superset, and every Intake target carries a `RouteTargetId`. We
  // narrow here for the classifier's verdict type.
  return (await assembleAllTargets()) as RouteTarget[];
}

/**
 * Render the assembled registry into the guidance block injected after the
 * Capture text in the classifier prompt. One stanza per target: its id and its
 * guidance prose. Kept here (not in the persona) because the target SET is
 * dynamic per Capture while the persona is static.
 */
export function renderTargetGuidance(targets: RouteTarget[]): string {
  const lines = targets.map((t) => `- ${t.id}\n  ${t.guidance}`);
  return `Available Route targets (pick exactly one id, or null for Unsorted):\n${lines.join("\n")}`;
}
