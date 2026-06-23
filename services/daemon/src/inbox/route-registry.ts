/**
 * FRI-142 / ADR-048 — Producer-agnostic Route-target registry (DAEMON-ONLY).
 *
 * Layer 3 of FRI-142: the Inbox (`inbox_items`) becomes the generic, persisted
 * actionable-item store and **Intake is merely producer #1**. This module lifts
 * the `target_id → executor` resolution OUT of `intake/` so a future non-Intake
 * producer (an agent's "approve this merge?", a system "renew this cert?") can
 * write a Proposed/Done row whose `target_id` resolves + executes through the
 * SAME registry — with no Intake coupling.
 *
 * Before this, `approveInbox`/`undoInbox`/`triageInbox` resolved targets via
 * `assembleRegistry()` under `intake/`, which is hard-bound to Intake's route
 * taxonomy (core reminder/habit/memory/ticket + app/orchestrator mail). A
 * non-Intake `target_id` threw "route target … is no longer available". Now any
 * registered target resolves.
 *
 * Two registration shapes, because targets come in two flavours:
 *   - STATIC targets — a fixed `RouteTarget` registered once at startup (core
 *     intake targets; a future `system:*` producer's targets). Held in a Map.
 *   - DYNAMIC providers — a `() => Promise<RouteTarget[]>` evaluated at resolve
 *     time, because the target SET changes at runtime (Intake's `agent:<name>`
 *     mail targets depend on which apps are installed right now). Held as a
 *     list of provider fns.
 *
 * Resolution merges both: `resolveTarget(id)` checks the static Map first, then
 * walks the dynamic providers. The id is a plain `string` — deliberately WIDER
 * than Intake's `RouteTargetId`, so a non-Intake id resolves without widening
 * the Intake type.
 */

/** The reversibility + deep-link reference an executor returns (mirrors the
 *  intake executors' `ResultReference`; owned here so it is producer-agnostic). */
export interface ResultReference {
  /** True when the created artifact can be reversed. */
  undoable: boolean;
  /** Human label for the inverse, e.g. "Delete the reminder". Set iff undoable. */
  inverseLabel?: string;
  /** Deep-link to the created/affected artifact. */
  deepLink: string;
}

/**
 * A single actionable Route target, producer-agnostic. `id` is a plain string
 * (`core:reminder`, `agent:<name>`, or any producer's own scheme). `execute`
 * performs the forward action and returns a {@link ResultReference}. `undo` —
 * when present — reverses a Done item created by `execute`, dispatched on the
 * row's `deepLink`; absent ⇒ the target is not reversible (the CTA is View).
 *
 * `payloadSchema` re-validates a staged payload before (re-)executing. It is a
 * minimal structural validator (a `safeParse`) so a non-Intake producer can
 * supply a plain zod-like object without importing zod's full surface here.
 */
export interface RouteTarget {
  id: string;
  /** Natural-language routing guidance (Intake injects it into the classifier
   *  prompt; non-Intake producers may leave it empty). */
  guidance: string;
  /** Validates a payload before execution. Returns the parsed value or a
   *  failure — the same contract zod's `safeParse` provides. */
  payloadSchema: { safeParse: (data: unknown) => SafeParseResult };
  /** Run the forward action. */
  execute: (payload: unknown) => Promise<ResultReference>;
  /** Reverse a Done item (delete the reminder/check-in/memory). Optional —
   *  absent ⇒ not reversible. Receives the row's deep-link; returns whether the
   *  artifact was actually removed (idempotent: already-gone ⇒ false is fine). */
  undo?: (deepLink: string) => Promise<boolean>;
}

/** The shape zod's `safeParse` returns (so callers don't import zod here). */
export type SafeParseResult =
  | { success: true; data: unknown }
  | { success: false; error: { message: string } };

/** A provider evaluated at resolve time for runtime-dynamic target sets. */
export type TargetProvider = () => Promise<RouteTarget[]>;

/** Statically-registered single targets, keyed by id. */
const staticTargets = new Map<string, RouteTarget>();
/** Providers re-evaluated on every assemble/resolve (runtime-dynamic sets). */
const providers: TargetProvider[] = [];

/** Register one static target. Idempotent by id — a re-register overwrites
 *  (the latest definition wins), so a startup that re-runs is safe. */
export function registerTarget(target: RouteTarget): void {
  staticTargets.set(target.id, target);
}

/** Register many static targets at once. */
export function registerTargets(targets: readonly RouteTarget[]): void {
  for (const t of targets) registerTarget(t);
}

/** Register a runtime-dynamic provider (e.g. Intake's app/orchestrator mail
 *  targets, which depend on the currently-installed apps). */
export function registerTargetProvider(provider: TargetProvider): void {
  providers.push(provider);
}

/**
 * Assemble the full current target set: every static target plus every provider's
 * current output. Static targets win on an id collision (a provider can't shadow
 * an explicitly-registered core target). Order: static first, then providers in
 * registration order, de-duplicated by id.
 */
export async function assembleAllTargets(): Promise<RouteTarget[]> {
  const byId = new Map<string, RouteTarget>(staticTargets);
  for (const provider of providers) {
    const produced = await provider();
    for (const t of produced) {
      if (!byId.has(t.id)) byId.set(t.id, t);
    }
  }
  return [...byId.values()];
}

/**
 * Resolve a single target by id through the producer-agnostic registry: the
 * static Map first (cheap, no provider evaluation when the id is a core target),
 * then the dynamic providers. Returns `null` when no registered target matches —
 * callers turn that into the user-facing "route target no longer available".
 */
export async function resolveTarget(id: string): Promise<RouteTarget | null> {
  const fromStatic = staticTargets.get(id);
  if (fromStatic) return fromStatic;
  for (const provider of providers) {
    const produced = await provider();
    const found = produced.find((t) => t.id === id);
    if (found) return found;
  }
  return null;
}

/** Test-only: clear all registrations so a test starts from an empty registry
 *  and injects exactly the targets it asserts on. */
export function __resetRouteRegistryForTest(): void {
  staticTargets.clear();
  providers.length = 0;
}
