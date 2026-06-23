// FRI-142 / ADR-048 — App-icon badge count (daemon-only).
//
// The single source of truth for the unread badge is the open ATTENTION-worthy
// `inbox_items` — exactly the count the header bell shows in its attention tone.
// "Attention-worthy" = a row that needs a DECISION: `kind IN ('proposed',
// 'unsorted')`. `done` items are FYI (low-priority, auto-resolve on view) and do
// NOT bump the home-screen badge.
//
// The client sets the badge from its reactive Inbox store while the app is open
// (`navigator.setAppBadge`). For the CLOSED-app case the daemon recomputes this
// same count at PUSH time (one `COUNT(*)` per push — low frequency) and stamps it
// into the push payload, so the service worker can call `setAppBadge` from its
// `push` handler while the app is not running. Recompute-at-send keeps a single
// source of truth (ADR-048; FRI-142 BLOCKED-ON-OWNER default 5(a)).

import { and, count, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";

/** Inbox kinds that need a decision and therefore bump the badge. */
const ATTENTION_KINDS = ["proposed", "unsorted"] as const;

/**
 * The open attention-worthy `inbox_items` count: `state='open'` AND
 * `kind IN ('proposed','unsorted')`. This is the number stamped into a push
 * payload's `badge` field and the number the client mirrors via `setAppBadge`.
 */
export async function computeBadgeCount(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: count() })
    .from(schema.inboxItems)
    .where(
      and(
        eq(schema.inboxItems.state, "open"),
        inArray(schema.inboxItems.kind, [...ATTENTION_KINDS]),
      ),
    );
  return rows[0]?.n ?? 0;
}
