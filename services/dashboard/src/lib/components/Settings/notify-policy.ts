/**
 * FRI-142 (ADR-048): the Settings preset sugar over the per-channel
 * `notify_policy` rules.
 *
 * The truth is the `notify_policy` map: `{ <eventType>: { <channel>: <rule> } }`
 * where rule ∈ {never, present_only, absent_only, always}. The Settings UI does
 * NOT expose the raw 2-channel × 4-rule matrix per event — it offers four
 * friendly PRESETS that each WRITE a concrete `{toast, push}` rule pair. The
 * presets are a VIEW; this module is the lossy-but-stable mapping between them.
 *
 * The four presets:
 *   - `auto`        — the event's DEFAULT_NOTIFY_POLICY entry (per-event: most
 *                     are toast present_only / push absent_only; mail is push
 *                     never; evolve_critical is both always). "Do the sensible
 *                     thing for this event."
 *   - `always_push` — toast present_only, push always. "Always buzz my phone."
 *   - `toast_only`  — toast present_only, push never. "In-app only, never push."
 *   - `off`         — toast never, push never. "Silence this event entirely."
 *
 * `resolveEffective` overlays the stored (partial) policy on the default, so an
 * event/channel the user never touched reads its default rule. `presetForEvent`
 * classifies the effective {toast, push} pair back to a preset for rendering
 * the active selection; an exotic hand-edited pair that matches no preset reads
 * as `custom` (rendered as "Custom" and selectable presets overwrite it).
 */

import {
  DEFAULT_NOTIFY_POLICY,
  type Channel,
  type DeliveryRule,
  type NotifyEventType,
  type NotifyPolicy,
} from "@friday/shared/sync";

export type NotifyPreset = "auto" | "always_push" | "toast_only" | "off";

/** The preset chips the Settings card renders per event, in display order. */
export const NOTIFY_PRESETS: { id: NotifyPreset; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "always_push", label: "Always push" },
  { id: "toast_only", label: "Toast only" },
  { id: "off", label: "Off" },
];

/** The concrete per-channel rules an event currently resolves to. */
export type ChannelRules = Record<Channel, DeliveryRule>;

/**
 * Overlay the stored (partial) policy on DEFAULT_NOTIFY_POLICY for one event,
 * producing the fully-resolved `{toast, push}` rule pair the router would use.
 * A missing event key OR a missing channel key falls through to the default.
 */
export function resolveEffective(
  policy: NotifyPolicy | null | undefined,
  event: NotifyEventType,
): ChannelRules {
  const base = DEFAULT_NOTIFY_POLICY[event];
  const overlay = policy?.[event];
  return {
    toast: overlay?.toast ?? base.toast,
    push: overlay?.push ?? base.push,
  };
}

/** The concrete `{toast, push}` rules a preset selection writes for an event.
 *  `auto` is per-event (reads the default); the other three are fixed pairs. */
export function rulesForPreset(preset: NotifyPreset, event: NotifyEventType): ChannelRules {
  switch (preset) {
    case "auto":
      return { toast: DEFAULT_NOTIFY_POLICY[event].toast, push: DEFAULT_NOTIFY_POLICY[event].push };
    case "always_push":
      return { toast: "present_only", push: "always" };
    case "toast_only":
      return { toast: "present_only", push: "never" };
    case "off":
      return { toast: "never", push: "never" };
  }
}

/**
 * Classify an event's effective rules back to a preset for the active-chip
 * highlight. Checks `auto` FIRST so an event whose rules equal its default
 * reads as Auto (even when that default coincides with another preset's pair,
 * e.g. mail_delivered's default {present_only, never} also matches toast_only —
 * Auto wins for the default). Returns `null` ("Custom") for a hand-edited pair
 * that matches no preset.
 */
export function presetForEvent(
  policy: NotifyPolicy | null | undefined,
  event: NotifyEventType,
): NotifyPreset | null {
  const eff = resolveEffective(policy, event);
  const eq = (r: ChannelRules) => r.toast === eff.toast && r.push === eff.push;
  if (eq(rulesForPreset("auto", event))) return "auto";
  for (const preset of ["always_push", "toast_only", "off"] as const) {
    if (eq(rulesForPreset(preset, event))) return preset;
  }
  return null;
}

/**
 * Produce the NEXT full `notify_policy` map after selecting `preset` for one
 * event — a pure function over the current policy (overlay-on-default). We
 * always materialize the explicit `{toast, push}` pair for the chosen event
 * (even for `auto`) so the stored row is self-describing and the daemon router
 * never has to re-derive the default; other events are carried over verbatim.
 */
export function applyPreset(
  policy: NotifyPolicy | null | undefined,
  event: NotifyEventType,
  preset: NotifyPreset,
): NotifyPolicy {
  const next: NotifyPolicy = { ...(policy ?? {}) };
  next[event] = rulesForPreset(preset, event);
  return next;
}

/**
 * The exact `updateSettings` arg the card writes when a preset chip is clicked
 * for one event: the next full materialized `notify_policy` map. Extracted as a
 * pure function so the write contract is unit-testable without a DOM (the
 * dashboard vitest pool is node-only; component-DOM behavior is Playwright's).
 */
export function presetMutatorArg(
  policy: NotifyPolicy | null | undefined,
  event: NotifyEventType,
  preset: NotifyPreset,
): { notifyPolicy: NotifyPolicy } {
  return { notifyPolicy: applyPreset(policy, event, preset) };
}

/**
 * The exact `updateSettings` arg for a DND time-input change. An empty input
 * clears that bound (`null` ⇒ no DND on that side); a "HH:MM" value sets it.
 * `which` picks the bound so a single helper covers both inputs.
 */
export function dndMutatorArg(
  which: "start" | "end",
  value: string,
): { dndStart: string | null } | { dndEnd: string | null } {
  const v = value === "" ? null : value;
  return which === "start" ? { dndStart: v } : { dndEnd: v };
}

/**
 * The exact `updateSettings` arg for the critical-bypass master toggle. The
 * boolean rides through verbatim — extracted (like {@link presetMutatorArg} /
 * {@link dndMutatorArg}) so all three of the Notifications card's write
 * contracts are pinned by a DOM-free unit test, not just asserted inline in the
 * component's reactive `$effect`. `settings.critical_bypass_dnd` is NOT NULL in
 * Postgres, so this only ever carries a concrete `true`/`false`, never null.
 */
export function criticalBypassMutatorArg(checked: boolean): { criticalBypassDnd: boolean } {
  return { criticalBypassDnd: checked };
}

/** Human label for each event-type row in the Settings card. */
export const EVENT_LABELS: Record<NotifyEventType, string> = {
  capture_attention: "Capture needs a look",
  builder_archive: "Builder finished or failed",
  schedule_fired: "Scheduled agent result",
  mail_delivered: "Mail delivered",
  evolve_critical: "Evolve promoted to critical",
};
