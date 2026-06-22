// Cross-cutting Intake / Inbox data shapes (FRI-171, ADR-047).
//
// Browser-safe by construction: this module declares ONLY types and a couple
// of `const` literal arrays — no `node:*` imports, no runtime IO. It is
// consumed by both the daemon (classifier + executors + intake endpoint) and
// the dashboard (Inbox store + bell), and is safe to re-export `import type`
// from the client-bundled `sync/` surface. Keep it node-free: see
// `sync/index.ts` and `model-ids.ts` for the browser-bundle contract.
//
// The DAEMON-ONLY `RouteTarget` interface (executor + zod `payloadSchema`)
// lives in `services/daemon/src/intake/registry.ts`, NOT here — the executor
// touches `sendMail`/`upsertSchedule`/`saveEntry`/`createTicket` and the
// Claude SDK, all node-side. This module holds only the data shapes that cross
// the daemon↔dashboard boundary.

/**
 * The four code-owned core Route targets. Each is reached by a direct
 * tool/mutator (reminder, habit check-in, memory append, native ticket).
 */
export type CoreRouteTargetId = "core:reminder" | "core:habit" | "core:memory" | "core:ticket";

/**
 * A Route target id: a code-owned core target, or `agent:<name>` for an
 * installed app's bare agent (or the orchestrator) reached by mail (ADR-017).
 * App targets are string-typed at runtime (the agent name is open-set), so
 * this is a template-literal union rather than a closed enum.
 */
export type RouteTargetId = CoreRouteTargetId | `agent:${string}`;

/** Capture provenance (the `inbox_items.source` column). Open set — recorded
 *  for audit and to stamp `blocks.source`, never a behavioral lever. */
export type IntakeSource = "watch" | "quick_add";

/**
 * An Inbox item's fixed classification, set once at creation (the
 * `inbox_items.kind` column; CHECK-constrained in Postgres):
 * - `done`     — a reversible core action the router already executed (FYI + undo).
 * - `proposed` — a higher-stakes action staged for approve/reject.
 * - `unsorted` — a Capture the router could not confidently classify (Gate 1 fail).
 */
export type InboxKind = "done" | "proposed" | "unsorted";

/** An Inbox item's lifecycle state (the `inbox_items.state` column; NOT
 *  `status`, which is reserved for Turn state / Status projection). Moves
 *  `open → resolved`. */
export type InboxState = "open" | "resolved";

/**
 * The single structured object the Intake router (classifier) emits per
 * Capture. The classifier emits this as JSON in its assistant text; the
 * daemon JSON-parses + zod-validates it before gating.
 *
 * Gate logic (daemon, after parse):
 * - `targetId === null` ⇒ Gate 1 failure ⇒ write an **Unsorted** item (no executor).
 * - `disposition === "act"` AND `payload` validates against the target's
 *   `payloadSchema` ⇒ run the executor now, write a **Done** item.
 * - `disposition === "propose"` OR payload validation fails ⇒ write a
 *   **Proposed** item carrying the payload (never silently dropped).
 */
export interface IntakeVerdict {
  /** The faithfully-cleaned Capture text (ums/uhs/typos removed; meaning preserved). */
  cleaned: string;
  /** The chosen Route target id, or `null` ⇒ Gate 1 failure ⇒ Unsorted. */
  targetId: RouteTargetId | null;
  /** The structured payload for the target's executor (shape per the target's `payloadSchema`). */
  payload: Record<string, unknown> | null;
  /** The classifier's act-vs-stage judgment (Gate 2). */
  disposition: "act" | "propose";
  /** One-line human-readable reason for the route/disposition. */
  rationale: string;
}

/**
 * A single Inbox row as the dashboard reads it from Zero. Field names mirror
 * the `inbox_items` Zero table declaration (`sync/schema.ts`) exactly:
 * timestamps cross the wire as epoch-millis numbers; nullable columns are
 * `| null`. This is the canonical row shape the bell + Inbox review surface
 * bind to.
 */
export interface InboxItem {
  id: string;
  created_at: number;
  source: string;
  raw_text: string;
  cleaned_text: string | null;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  rationale: string | null;
  kind: InboxKind;
  state: InboxState;
  resolved_at: number | null;
  undoable: boolean;
  inverse_label: string | null;
  deep_link: string | null;
}
