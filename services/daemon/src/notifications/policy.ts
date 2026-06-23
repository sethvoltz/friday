// FRI-142 / ADR-048 — Pure policy × presence × DND resolver (daemon-only).
//
// The HEART of the stateless Notification router, factored out as a PURE
// function so every gate branch (each DeliveryRule × presence; DND suppression;
// critical-bypass on/off) is unit-testable with plain inputs and an exact
// channel-set output — no DB, no SSE, no web-push, no clock IO. The router
// (notify.ts) gathers the inputs (effective policy, presence verdict, DND
// state) and calls `resolveChannels`; this module decides WHICH channels fire.
//
// Resolution order, per (eventType, channel):
//   1. The effective rule (stored policy overlaid on DEFAULT_NOTIFY_POLICY) is
//      resolved against the presence verdict:
//        never        → off
//        present_only → on iff present
//        absent_only  → on iff absent
//        always       → on
//   2. THEN DND overlays the PUSH channel only: inside the DND window, push is
//      suppressed UNLESS the event is critical AND the critical-bypass master
//      toggle is on. DND never touches Toast (an in-app toast is silent + only
//      shown to a present client; the phone-buzz concern is push-specific).
//   3. Presence can only ever DOWNGRADE a push to a toast, never the reverse —
//      an absent user with `present_only` push simply gets no push (fail-safe
//      over-push is enforced upstream: unknown presence ⇒ absent ⇒ push).

import {
  CHANNELS,
  DEFAULT_NOTIFY_POLICY,
  type Channel,
  type DeliveryRule,
  type NotifyEventType,
  type NotifyPolicy,
} from "@friday/shared";

/** The fully-resolved per-channel fire decision the router acts on. */
export type ChannelDecision = Record<Channel, boolean>;

/** Inputs the pure resolver needs (gathered by the router from settings +
 *  presence). Keeping them explicit is what makes every branch testable. */
export interface ResolveInput {
  /** Which event taxonomy key's policy applies. */
  eventType: NotifyEventType;
  /** OR-aggregated user presence (true ⇒ present on some client). */
  present: boolean;
  /** The user's effective policy (stored, possibly partial; overlaid on the
   *  default per-key here). */
  policy: NotifyPolicy;
  /** Whether the current wall-clock falls inside the DND window. */
  inDnd: boolean;
  /** True iff this event is in the critical class (evolve_critical OR a
   *  priority='critical' mail) — the only events the bypass toggle frees. */
  critical: boolean;
  /** The `critical_bypass_dnd` master toggle (NOT NULL, default true). */
  criticalBypassDnd: boolean;
}

/**
 * Resolve the effective DeliveryRule for one (eventType, channel): the stored
 * policy's value if present, else the ADR-048 default. Partial at both levels —
 * a missing event key or a missing channel key falls through to the default.
 */
export function effectiveRule(
  policy: NotifyPolicy,
  eventType: NotifyEventType,
  channel: Channel,
): DeliveryRule {
  return policy[eventType]?.[channel] ?? DEFAULT_NOTIFY_POLICY[eventType][channel];
}

/** Resolve a single DeliveryRule against the presence verdict (step 1). */
function ruleFires(rule: DeliveryRule, present: boolean): boolean {
  switch (rule) {
    case "never":
      return false;
    case "present_only":
      return present;
    case "absent_only":
      return !present;
    case "always":
      return true;
    default: {
      const exhaustive: never = rule;
      return Boolean(exhaustive);
    }
  }
}

/**
 * The pure decision: for each Channel, does it fire? Applies policy×presence,
 * then the push-only DND overlay (step 2). Returns the exact `{ toast, push }`
 * map the router fans out on — every key always present, so a caller (and a
 * test) reads an unambiguous boolean per channel.
 */
export function resolveChannels(input: ResolveInput): ChannelDecision {
  const decision = {} as ChannelDecision;
  for (const channel of CHANNELS) {
    const rule = effectiveRule(input.policy, input.eventType, channel);
    let fire = ruleFires(rule, input.present);
    // DND overlays PUSH only. Inside the window, push is suppressed unless this
    // is a critical event AND the master bypass toggle is on.
    if (fire && channel === "push" && input.inDnd) {
      const bypass = input.critical && input.criticalBypassDnd;
      if (!bypass) fire = false;
    }
    decision[channel] = fire;
  }
  return decision;
}

/**
 * Whether `nowHHMM` ("HH:MM", 24h local) falls inside the DND window
 * [start, end). Both bounds are required — a NULL on either ⇒ no DND (returns
 * false). Supports a window that crosses midnight (start > end), e.g.
 * 22:00→07:00: inside iff now ≥ start OR now < end. An exact start is inside,
 * an exact end is outside (half-open) so a 1-minute window is well-defined.
 */
export function isInDndWindow(nowHHMM: string, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const n = hhmmToMinutes(nowHHMM);
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  if (n == null || s == null || e == null) return false;
  if (s === e) return false; // zero-length window ⇒ never in DND
  if (s < e) return n >= s && n < e; // same-day window
  return n >= s || n < e; // crosses midnight
}

/** Parse "HH:MM" → minutes-since-midnight, or null if malformed. */
function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
