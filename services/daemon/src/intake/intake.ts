/**
 * FRI-171 / ADR-047 — Intake orchestration + Gate 1 / Gate 2 dispatch
 * (DAEMON-ONLY).
 *
 * The stateless intake pipeline for one Capture:
 *
 *   assemble the Route-target registry
 *     → classify the Capture into an IntakeVerdict (single-turn query)
 *       → gate the verdict (Gate 1 / Gate 2)
 *         → run the executor (act path) and/or write ONE inbox_items row.
 *
 * Gate logic (the heart — §3.2 of the build contract):
 *   - Gate 1: `targetId === null` ⇒ write an UNSORTED item (no executor).
 *   - Gate 2: `disposition === "act"` AND the payload validates against the
 *     chosen target's `payloadSchema` ⇒ run the executor NOW, write a DONE item
 *     referencing the created artifact.
 *   - `disposition === "propose"` OR the payload FAILS validation OR the
 *     executor THROWS ⇒ write a PROPOSED item carrying the payload. The Capture
 *     is NEVER silently dropped — every path writes exactly one row.
 *
 * The classifier + executors + DB write all live in the daemon process; nothing
 * here is reachable from the client bundle (`packages/shared/src/sync/`).
 */

import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";
import type { IntakeSource, IntakeVerdict } from "@friday/shared";
import { logger } from "../log.js";
import { assembleRegistry, type RouteTarget } from "./registry.js";
import { classifyCapture, IntakeClassifierError } from "./classifier.js";
import { undoArtifact } from "./executors.js";

/** Wall-clock budget for the synchronous clean+classify+dispatch path. On
 *  timeout the classifier is aborted; the caller still returns a queued shape
 *  and the eventual row (if any) lands in the bell. */
export const INTAKE_TIMEOUT_MS = 25_000;

/** The row the dispatcher wrote, projected for the endpoint response. */
export interface IntakeResult {
  /** The faithfully-cleaned Capture (echoed back to the caller / Watch). */
  cleaned: string;
  /** The lane the Capture landed in. */
  kind: "done" | "proposed" | "unsorted";
  /** The verdict's act/propose judgment (as recorded; act may degrade to a
   *  proposed row if validation/execution failed). */
  disposition: "act" | "propose";
  /** One-line reason for the route/disposition. */
  rationale: string;
}

/** Build the base inbox row fields shared by every lane. */
function baseRow(source: IntakeSource, rawText: string, verdict: IntakeVerdict) {
  return {
    createdAt: new Date(),
    source,
    rawText,
    cleanedText: verdict.cleaned,
    rationale: verdict.rationale,
    state: "open" as const,
  };
}

/**
 * Gate a parsed verdict against the assembled registry and write exactly one
 * `inbox_items` row, running the executor on the act path. PURE of the SDK —
 * the verdict + registry are passed in, so a unit test can drive every gate
 * branch with mocked executors and a canned verdict.
 *
 * @param source   Capture provenance (recorded on the row).
 * @param rawText  the original Capture (recorded verbatim).
 * @param verdict  the classifier's verdict.
 * @param targets  the assembled Route targets (to find the chosen executor +
 *                 re-validate the payload).
 */
export async function dispatchVerdict(
  source: IntakeSource,
  rawText: string,
  verdict: IntakeVerdict,
  targets: RouteTarget[],
): Promise<IntakeResult> {
  const db = getDb();
  const base = baseRow(source, rawText, verdict);

  // Gate 1 — no confident route ⇒ Unsorted (no executor, no target/payload).
  if (verdict.targetId === null) {
    await db.insert(schema.inboxItems).values({
      ...base,
      targetId: null,
      payload: null,
      kind: "unsorted",
      undoable: false,
    });
    return {
      cleaned: verdict.cleaned,
      kind: "unsorted",
      disposition: verdict.disposition,
      rationale: verdict.rationale,
    };
  }

  const target = targets.find((t) => t.id === verdict.targetId);

  // A targetId the registry doesn't contain (stale app, hallucinated id) is a
  // route we can't execute — stage it as Proposed rather than drop it.
  if (!target) {
    await writeProposed(db, base, verdict);
    logger.log("warn", "intake.dispatch.unknown-target", { targetId: verdict.targetId });
    return {
      cleaned: verdict.cleaned,
      kind: "proposed",
      disposition: "propose",
      rationale: verdict.rationale,
    };
  }

  // Gate 2 — act ONLY when the verdict says act AND the payload validates AND
  // the executor succeeds. ANY of these failing degrades to Proposed (the
  // Capture is never dropped).
  if (verdict.disposition === "act") {
    const validated = target.payloadSchema.safeParse(verdict.payload);
    if (!validated.success) {
      // AC8: payload-validation failure degrades act → Proposed, carrying the
      // (unexecuted) payload for later approve/triage. Executor never runs.
      await writeProposed(db, base, verdict);
      logger.log("info", "intake.dispatch.payload-invalid.degrade-propose", {
        targetId: verdict.targetId,
        error: validated.error.message,
      });
      return {
        cleaned: verdict.cleaned,
        kind: "proposed",
        disposition: "propose",
        rationale: verdict.rationale,
      };
    }
    try {
      const ref = await target.execute(validated.data);
      await db.insert(schema.inboxItems).values({
        ...base,
        targetId: verdict.targetId,
        payload: verdict.payload,
        kind: "done",
        undoable: ref.undoable,
        inverseLabel: ref.inverseLabel ?? null,
        deepLink: ref.deepLink,
      });
      return {
        cleaned: verdict.cleaned,
        kind: "done",
        disposition: "act",
        rationale: verdict.rationale,
      };
    } catch (err) {
      // Executor failure (e.g. habit name didn't resolve) ⇒ Proposed, never
      // dropped. The payload is preserved so the user can approve/triage.
      await writeProposed(db, base, verdict);
      logger.log("warn", "intake.dispatch.execute.error.degrade-propose", {
        targetId: verdict.targetId,
        err: (err as Error).message,
      });
      return {
        cleaned: verdict.cleaned,
        kind: "proposed",
        disposition: "propose",
        rationale: verdict.rationale,
      };
    }
  }

  // disposition === "propose" — stage for review, carrying the payload.
  await writeProposed(db, base, verdict);
  return {
    cleaned: verdict.cleaned,
    kind: "proposed",
    disposition: "propose",
    rationale: verdict.rationale,
  };
}

/** Write a Proposed row carrying the (unexecuted) target + payload. */
async function writeProposed(
  db: ReturnType<typeof getDb>,
  base: ReturnType<typeof baseRow>,
  verdict: IntakeVerdict,
): Promise<void> {
  await db.insert(schema.inboxItems).values({
    ...base,
    targetId: verdict.targetId,
    payload: verdict.payload,
    kind: "proposed",
    undoable: false,
  });
}

/**
 * Full intake pipeline for one Capture: assemble the registry, classify, gate,
 * write the row. Synchronous-with-timeout — on timeout the classifier is
 * aborted and the failure degrades to a Proposed row (the Capture still lands
 * in the bell), so the caller never loses the Capture.
 *
 * A classifier failure (parse/validate/timeout) writes a Proposed row built
 * from the raw Capture with a null target, so the user can triage it manually.
 */
export async function runIntake(source: IntakeSource, text: string): Promise<IntakeResult> {
  const targets = await assembleRegistry();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), INTAKE_TIMEOUT_MS);
  try {
    const verdict = await classifyCapture(text, targets, abort.signal);
    return await dispatchVerdict(source, text, verdict, targets);
  } catch (err) {
    // Classifier failed (bad JSON, validation, or aborted by the timeout). Do
    // NOT drop the Capture — write a Proposed row from the raw text with no
    // route, so it surfaces in the bell for manual triage.
    const degraded: IntakeVerdict = {
      cleaned: text,
      targetId: null,
      payload: null,
      disposition: "propose",
      rationale:
        err instanceof IntakeClassifierError
          ? `classifier could not produce a verdict: ${err.message}`
          : `intake failed: ${(err as Error).message}`,
    };
    const db = getDb();
    await db.insert(schema.inboxItems).values({
      ...baseRow(source, text, degraded),
      targetId: null,
      payload: null,
      kind: "proposed",
      undoable: false,
    });
    logger.log("warn", "intake.run.degrade-propose", { err: (err as Error).message });
    return {
      cleaned: text,
      kind: "proposed",
      disposition: "propose",
      rationale: degraded.rationale,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Reference to the artifact an approve/undo created or reversed — echoed back
 *  to the dashboard so it can update the Done row's CTA + deep-link. */
export interface InboxActionResult {
  /** True iff the executor/inverse ran cleanly. */
  ok: boolean;
  /** The undoability of the created artifact (Approve only). */
  undoable?: boolean;
  /** Human label for the inverse, if undoable (Approve only). */
  inverseLabel?: string | null;
  /** Deep-link to the created/affected artifact (Approve only). */
  deepLink?: string | null;
}

/**
 * Approve a staged item: re-validate its payload against the target's schema
 * and run the SAME executor the act path would have, server-side. Only an OPEN
 * Proposed row is actionable; anything else is a no-op (idempotent against a
 * double-approve from two devices). Throws on a validation/executor failure so
 * the caller surfaces it and does NOT flip the state — the row stays Proposed.
 *
 * The state flip (open → resolved) is done by the `inboxApprove` Zero mutator
 * on the dashboard AFTER this returns ok; the executor never runs client-side.
 */
export async function approveInbox(id: string): Promise<InboxActionResult> {
  const db = getDb();
  const rows = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id));
  const row = rows[0];
  if (!row) throw new Error(`inbox item ${id} not found`);
  if (row.state !== "open" || row.kind !== "proposed") {
    // Already resolved or not a Proposed item — nothing to execute.
    return { ok: true };
  }
  if (!row.targetId) throw new Error(`inbox item ${id} has no route target to approve`);
  const targets = await assembleRegistry();
  const target = targets.find((t) => t.id === row.targetId);
  if (!target) throw new Error(`route target "${row.targetId}" is no longer available`);
  const validated = target.payloadSchema.safeParse(row.payload);
  if (!validated.success) {
    throw new Error(`payload no longer valid for "${row.targetId}": ${validated.error.message}`);
  }
  const ref = await target.execute(validated.data);
  // Promote the row to Done so its CTA becomes Undo/View. The dashboard's
  // mutator then flips `state` resolved; we stamp the artifact fields here so
  // the canonical row carries the deep-link/undoability the executor produced.
  await db
    .update(schema.inboxItems)
    .set({
      kind: "done",
      undoable: ref.undoable,
      inverseLabel: ref.inverseLabel ?? null,
      deepLink: ref.deepLink,
    })
    .where(eq(schema.inboxItems.id, id));
  logger.log("info", "intake.approve", { id, targetId: row.targetId, undoable: ref.undoable });
  return {
    ok: true,
    undoable: ref.undoable,
    inverseLabel: ref.inverseLabel ?? null,
    deepLink: ref.deepLink,
  };
}

/**
 * Undo a Done item: run the inverse executor (delete the reminder / check-in /
 * memory) server-side, dispatched on the row's `target_id` + the artifact id
 * parsed from its `deep_link`. Only an OPEN, undoable Done row is actionable.
 * Idempotent — a second undo (artifact already gone) returns ok with no error.
 *
 * The state flip is done by the `inboxUndo` Zero mutator after this returns.
 */
export async function undoInbox(id: string): Promise<InboxActionResult> {
  const db = getDb();
  const rows = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id));
  const row = rows[0];
  if (!row) throw new Error(`inbox item ${id} not found`);
  if (row.state !== "open" || row.kind !== "done" || !row.undoable) {
    // Not an open undoable Done item — nothing to reverse.
    return { ok: true };
  }
  if (!row.targetId || !row.deepLink) {
    throw new Error(`inbox item ${id} is undoable but has no target/deep-link to reverse`);
  }
  const removed = await undoArtifact(row.targetId, row.deepLink);
  logger.log("info", "intake.undo", { id, targetId: row.targetId, removed });
  return { ok: true };
}

/**
 * Triage an Unsorted item to a chosen `agent:<name>` Route target: send the
 * item's cleaned (or raw) text to that agent by mail, server-side, then promote
 * the row to Done. Only an OPEN Unsorted row is actionable. The dashboard's
 * `inboxApprove`/state-flip mutator resolves the row after this returns ok.
 *
 * Triage is mail-only (the catch-all routing of a Capture the classifier could
 * not place); core targets are reached by re-classification, not manual triage.
 */
export async function triageInbox(id: string, targetId: string): Promise<InboxActionResult> {
  const db = getDb();
  const rows = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id));
  const row = rows[0];
  if (!row) throw new Error(`inbox item ${id} not found`);
  if (row.state !== "open" || row.kind !== "unsorted") {
    return { ok: true };
  }
  if (!targetId.startsWith("agent:")) {
    throw new Error(`triage target "${targetId}" must be an agent target`);
  }
  const targets = await assembleRegistry();
  const target = targets.find((t) => t.id === targetId);
  if (!target) throw new Error(`route target "${targetId}" is no longer available`);
  const body = row.cleanedText ?? row.rawText;
  const ref = await target.execute({ body });
  await db
    .update(schema.inboxItems)
    .set({
      targetId,
      payload: { body },
      kind: "done",
      undoable: ref.undoable,
      inverseLabel: ref.inverseLabel ?? null,
      deepLink: ref.deepLink,
    })
    .where(eq(schema.inboxItems.id, id));
  logger.log("info", "intake.triage", { id, targetId });
  return {
    ok: true,
    undoable: ref.undoable,
    inverseLabel: ref.inverseLabel ?? null,
    deepLink: ref.deepLink,
  };
}

/* ----------------------------------------------------------------------------
 * Orchestrator inbox surface (FRI-171, ADR-047)
 *
 * The dashboard drives the Inbox through Zero mutators: the daemon executor
 * runs server-side (approve/undo/triage above) and the `inbox*` mutator flips
 * `state` open→resolved on the client. The ORCHESTRATOR has no Zero session, so
 * its `friday-inbox` MCP tools need a daemon path that does BOTH — execute AND
 * flip state — in one call. The functions below reuse the SAME executor/dispatch
 * functions above (`approveInbox` / `undoInbox` / `triageInbox`) and then stamp
 * the state flip the mutator would have done; reject/dismiss are pure flips with
 * no executor. They are reached only via the orchestrator-only `/api/intake/act`
 * + `/api/intake/inbox` endpoints, surfaced as MCP tools at Seth's explicit
 * in-chat direction. There is NO timer / cron / out-of-band trigger — triage is
 * Seth's job (build contract §1).
 * --------------------------------------------------------------------------- */

/** One open Inbox item projected for the orchestrator to read + act on. */
export interface InboxItemView {
  id: string;
  /** Which lane the Capture landed in. */
  kind: "done" | "proposed" | "unsorted";
  /** Capture provenance (watch | quick_add | …). */
  source: string;
  /** The faithfully-cleaned Capture text (falls back to raw if unclassified). */
  text: string;
  /** Chosen Route target id (null ⇒ Unsorted). */
  targetId: string | null;
  /** One-line reason for the route/disposition. */
  rationale: string | null;
  /** Wall-clock age of the item in whole seconds (now − created_at). */
  ageSeconds: number;
  /** ISO creation timestamp (for an exact reference if needed). */
  createdAt: string;
  /** Whether a Done item can be reversed. */
  undoable: boolean;
  /** Deep-link to the created artifact, when one exists. */
  deepLink: string | null;
}

/**
 * List OPEN Inbox items, most-recent first, projected for the orchestrator.
 * Returns only `state='open'` rows — resolved items never surface here (the
 * pinned-list assertion). Read-only; no executor, no state change.
 */
export async function listOpenInbox(): Promise<InboxItemView[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.inboxItems)
    .where(eq(schema.inboxItems.state, "open"))
    .orderBy(desc(schema.inboxItems.createdAt));
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as InboxItemView["kind"],
    source: row.source,
    text: row.cleanedText ?? row.rawText,
    targetId: row.targetId ?? null,
    rationale: row.rationale ?? null,
    ageSeconds: Math.max(0, Math.floor((now - row.createdAt.getTime()) / 1000)),
    createdAt: row.createdAt.toISOString(),
    undoable: row.undoable,
    deepLink: row.deepLink ?? null,
  }));
}

/** Flip a single open Inbox row to resolved, stamping `resolved_at`. The state
 *  flip the dashboard's `inbox*` mutator does — done daemon-side for the
 *  orchestrator path. Idempotent: re-running on an already-resolved row matches
 *  zero rows (no-op). */
async function resolveRow(db: ReturnType<typeof getDb>, id: string): Promise<void> {
  await db
    .update(schema.inboxItems)
    .set({ state: "resolved", resolvedAt: new Date() })
    .where(eq(schema.inboxItems.id, id));
}

/** Reject a staged Proposed item: do NOT run its executor, just resolve it.
 *  Only an open Proposed row is actionable; anything else is an idempotent
 *  no-op. The payload is preserved on the row (preserve-over-delete). */
export async function rejectInbox(id: string): Promise<InboxActionResult> {
  const db = getDb();
  const rows = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id));
  const row = rows[0];
  if (!row) throw new Error(`inbox item ${id} not found`);
  if (row.state !== "open" || row.kind !== "proposed") return { ok: true };
  await resolveRow(db, id);
  logger.log("info", "intake.reject", { id });
  return { ok: true };
}

/** Dismiss any open Inbox item (Unsorted/Proposed/Done) without acting on it:
 *  pure state flip, no executor. Idempotent no-op on an already-resolved row. */
export async function dismissInbox(id: string): Promise<InboxActionResult> {
  const db = getDb();
  const rows = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id));
  const row = rows[0];
  if (!row) throw new Error(`inbox item ${id} not found`);
  if (row.state !== "open") return { ok: true };
  await resolveRow(db, id);
  logger.log("info", "intake.dismiss", { id });
  return { ok: true };
}

/** The actions the orchestrator MCP tool can take on an Inbox item. */
export type InboxAction = "approve" | "reject" | "dismiss" | "triage" | "undo";

/**
 * Act on one Inbox item by id, server-side, for the orchestrator MCP path.
 * Delegates to the SAME executor/dispatch functions the dashboard uses
 * (`approveInbox` / `triageInbox` / `undoInbox`) — NO duplicated executor logic
 * — and then flips `state` open→resolved (the step the Zero mutator does on the
 * dashboard, which the orchestrator has no session for). `reject`/`dismiss` are
 * pure state flips with no executor.
 *
 * The executor runs FIRST; only on success do we resolve the row, so a thrown
 * executor leaves the item open + actionable (matching the dashboard's
 * approve-then-flip ordering). `triage` requires `targetId`.
 */
export async function actInbox(
  id: string,
  action: InboxAction,
  targetId?: string,
): Promise<InboxActionResult> {
  const db = getDb();
  switch (action) {
    case "approve": {
      const result = await approveInbox(id);
      await resolveRow(db, id);
      return result;
    }
    case "undo": {
      const result = await undoInbox(id);
      await resolveRow(db, id);
      return result;
    }
    case "triage": {
      if (!targetId) throw new Error(`triage requires a targetId (agent:<name>)`);
      const result = await triageInbox(id, targetId);
      await resolveRow(db, id);
      return result;
    }
    case "reject":
      return rejectInbox(id);
    case "dismiss":
      return dismissInbox(id);
    default: {
      const exhaustive: never = action;
      throw new Error(`unknown inbox action "${String(exhaustive)}"`);
    }
  }
}
