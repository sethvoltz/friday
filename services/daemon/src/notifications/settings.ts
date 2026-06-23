// FRI-142 / ADR-048 — Read the Notification-policy + DND fields off the
// singleton `settings` row (daemon-only).
//
// `settings` is the single-row, Zero-replicated config table (PK = the literal
// "singleton"). The router reads the policy/DND/critical-bypass facet here at
// notify time. NULL `notify_policy` ⇒ the router falls back to
// DEFAULT_NOTIFY_POLICY (the resolver overlays per key, so a partial stored
// policy is also fine). NULL on either DND bound ⇒ no DND window.

import { eq } from "drizzle-orm";
import { getDb, schema, type NotifyPolicy } from "@friday/shared";

/** The PK of the single config row (mirrors settings/listener.ts). */
const SINGLETON_KEY = "singleton";

/** The Notification-relevant settings facet, normalized for the router. */
export interface NotifySettings {
  /** Stored policy (possibly partial); `{}` when the column is NULL — the
   *  resolver overlays this on DEFAULT_NOTIFY_POLICY per (event, channel). */
  policy: NotifyPolicy;
  /** DND window start "HH:MM" (local), or null ⇒ no DND. */
  dndStart: string | null;
  /** DND window end "HH:MM" (local), or null ⇒ no DND. */
  dndEnd: string | null;
  /** Master toggle: critical events bypass DND push-suppression. NOT NULL,
   *  defaults true; we default true here too if the row is somehow absent. */
  criticalBypassDnd: boolean;
}

/**
 * Read the Notification facet of the singleton settings row. Defensive: if the
 * row is missing (should not happen — the migration seeds it) we return the
 * fail-OPEN defaults (empty policy ⇒ DEFAULT_NOTIFY_POLICY, no DND, bypass on)
 * so a missing row never silences notifications.
 */
export async function readNotifySettings(): Promise<NotifySettings> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.id, SINGLETON_KEY))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { policy: {}, dndStart: null, dndEnd: null, criticalBypassDnd: true };
  }
  return {
    policy: (row.notifyPolicy as NotifyPolicy | null) ?? {},
    dndStart: row.dndStart ?? null,
    dndEnd: row.dndEnd ?? null,
    criticalBypassDnd: row.criticalBypassDnd ?? true,
  };
}
