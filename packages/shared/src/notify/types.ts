// Cross-cutting Notification contracts (FRI-142, ADR-048).
//
// Browser-safe by construction: this module declares ONLY types and `const`
// literals — no `node:*` imports, no runtime IO, no `web-push` (which is
// daemon-only and must never reach the dashboard/service-worker bundle). It is
// consumed by both the daemon (the stateless Notification router, presence
// tracker, push sender) and the dashboard (Settings policy UI, toast renderer,
// presence reporter, push subscribe flow). Keep it node-free — the same
// contract as `intake/types.ts`.
//
// A Notification (ADR-048) is a fire-and-forget, machine→human delivery — a
// transient *delivery*, never a row. The daemon's router consults the
// NotifyPolicy × presence × DND per event and fires zero or more Channels.

/**
 * The v1 Notification event taxonomy — the FIVE producer event ids.
 *
 * NOTE (ADR-048): `schedule_fired` and `mail_delivered` collide BY NAME with
 * two Phase-5-retired SSE event types, but they are UNRELATED — these are the
 * Notification router's OWN policy keys (a `notify_policy` map key), not wire
 * events. The retired SSE events had backing rows and moved to Zero; these are
 * router taxonomy strings with no storage. Do not conflate them.
 *
 * - `capture_attention` — a low-confidence / Proposed Capture needs a look.
 * - `builder_archive`   — a Builder finished or failed.
 * - `schedule_fired`    — a scheduled agent surfaced a result.
 * - `mail_delivered`    — mail flowed through the bridge.
 * - `evolve_critical`   — an evolve proposal was promoted to critical.
 */
export type NotifyEventType =
  | "capture_attention"
  | "builder_archive"
  | "schedule_fired"
  | "mail_delivered"
  | "evolve_critical";

/** All five event ids as a runtime-iterable tuple (settings UI rows over it). */
export const NOTIFY_EVENT_TYPES = [
  "capture_attention",
  "builder_archive",
  "schedule_fired",
  "mail_delivered",
  "evolve_critical",
] as const satisfies readonly NotifyEventType[];

/**
 * A delivery surface the router can fire. The set is OPEN — `email`/SMS/webhook
 * join later by adding a key here + a sender, never by expanding the rule enum.
 * The bell is NOT a Channel (it is the Inbox's persistent surface; the two
 * systems meet only at the badge count).
 */
export type Channel = "toast" | "push";

/** All channels as a runtime-iterable tuple. */
export const CHANNELS = ["toast", "push"] as const satisfies readonly Channel[];

/**
 * A presence-based, channel-agnostic delivery rule (the value in the
 * `notify_policy` map). Presence is OR-aggregated across all of a user's
 * clients; stale/unknown ⇒ treated as away (fail-safe over-push).
 *
 * - `never`        — never fire this channel for this event.
 * - `present_only` — fire only when the user is present on some client.
 * - `absent_only`  — fire only when the user is absent on every client.
 * - `always`       — fire regardless of presence.
 */
export type DeliveryRule = "never" | "present_only" | "absent_only" | "always";

/** All rules as a runtime-iterable tuple. */
export const DELIVERY_RULES = [
  "never",
  "present_only",
  "absent_only",
  "always",
] as const satisfies readonly DeliveryRule[];

/**
 * The full per-user policy: `{ <eventType>: { <channel>: <rule> } }`. Stored as
 * the `notify_policy` jsonb column on the Zero-replicated `settings` table
 * (NULL ⇒ DEFAULT_NOTIFY_POLICY). Partial at every level — a missing event or
 * channel key falls back to the default. The router resolves the effective rule
 * per (eventType, channel) by overlaying the stored policy on the default.
 */
export type NotifyPolicy = Partial<Record<NotifyEventType, Partial<Record<Channel, DeliveryRule>>>>;

/**
 * The ADR-048 default policy. The settings UI's friendly presets
 * (Auto / Always push / Toast only / Off) are pure sugar writing these rules;
 * this map is the truth a freshly-installed Friday starts from.
 *
 * - capture_attention / builder_archive / schedule_fired:
 *     toast `present_only`, push `absent_only` (the "Auto" preset).
 * - mail_delivered: toast `present_only`, push `never` (low-stakes; no phone buzz).
 * - evolve_critical: toast `always`, push `always` (critical; always reaches Seth).
 */
export const DEFAULT_NOTIFY_POLICY: Required<{
  [E in NotifyEventType]: Record<Channel, DeliveryRule>;
}> = {
  capture_attention: { toast: "present_only", push: "absent_only" },
  builder_archive: { toast: "present_only", push: "absent_only" },
  schedule_fired: { toast: "present_only", push: "absent_only" },
  mail_delivered: { toast: "present_only", push: "never" },
  evolve_critical: { toast: "always", push: "always" },
};

/**
 * The fire-and-forget event a producer hands to the daemon's `notify(event)`.
 * Pre-authored, terse — push payloads carry NO chat content / PII (title + body
 * + deep-link only; an in-app toast may render richer text since it never
 * leaves the device boundary the same way).
 */
export interface NotifyEvent {
  /** Which policy/DND rules apply. */
  type: NotifyEventType;
  /** Short notification title (push + toast headline). */
  title: string;
  /** One-line body. */
  body: string;
  /** Route to focus/open on click (push notificationclick + toast click). */
  deepLink?: string;
  /**
   * `critical` participates in the DND critical-bypass master toggle
   * (alongside `evolve_critical`, this is how a mail `priority='critical'`
   * event opts into bypassing DND). Defaults to `normal` when omitted.
   */
  priority?: "normal" | "critical";
}

/**
 * The presence heartbeat a client POSTs to `/api/presence` (on
 * `visibilitychange` + a ~20s keepalive). The daemon keys its in-memory
 * `Map<deviceId, { lastSeen, visible }>` on `deviceId` and OR-aggregates
 * `visible` per user (TTL ~45s; stale ⇒ away ⇒ push).
 */
export interface PresenceReport {
  /** The reporting client's device id (the `friday-device-id` cookie value). */
  deviceId: string;
  /** Whether the app is currently foregrounded/visible on this client. */
  visible: boolean;
}

/**
 * The body a client POSTs to `/api/push/subscribe` after
 * `pushManager.subscribe(...)`. Mirrors the browser `PushSubscription.toJSON()`
 * shape (`{ endpoint, keys: { p256dh, auth } }`) plus the reporting device id,
 * so the daemon can write a `push_subscriptions` row + wire the device FK.
 */
export interface PushSubscribePayload {
  /** The push service endpoint URL (unique per registration). */
  endpoint: string;
  keys: {
    /** ECDH public key (URL-safe base64). */
    p256dh: string;
    /** Auth secret (URL-safe base64). */
    auth: string;
  };
  /** The subscribing client's device id, for the FK + revoke-cascade. */
  deviceId: string;
}
