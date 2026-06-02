import { PostHog } from "posthog-node";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";

// Distinct id for events with no human originator (true daemon/service
// actions: crashes, agent lifecycle, schedules, autonomous turns). User-
// originated events attribute to the BetterAuth user id instead — see
// `captureFor`.
const SERVICE_DISTINCT_ID = "friday-daemon";

// System default: PostHog US cloud. Placed as the `??` fallback so a
// `POSTHOG_HOST` in `~/.friday/.env` (EU cloud / self-hosted) overrides
// it, mirroring the "system defaults in code" convention. With no
// `POSTHOG_API_KEY` set the client is constructed with an empty key and
// silently no-ops, so analytics are strictly opt-in.
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

const client = new PostHog(process.env.POSTHOG_API_KEY ?? "", {
  host: process.env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
  enableExceptionAutocapture: true,
});

// Per-id cache of BetterAuth identity (email/name) so we can $set person
// properties on daemon events without a DB round-trip per capture.
const identityCache = new Map<string, { email?: string; name?: string }>();

async function resolveIdentity(userId: string): Promise<{ email?: string; name?: string }> {
  const cached = identityCache.get(userId);
  if (cached) return cached;
  let ident: { email?: string; name?: string } = {};
  try {
    const rows = await getDb()
      .select({ email: schema.users.email, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (rows[0]) ident = { email: rows[0].email ?? undefined, name: rows[0].name ?? undefined };
  } catch {
    // Best-effort: a failed lookup just means no $set; the event still
    // attributes to the right distinct_id.
  }
  identityCache.set(userId, ident);
  return ident;
}

/**
 * Capture a daemon event, attributed to the BetterAuth user who originated it
 * when known, or the `friday-daemon` service actor otherwise.
 *
 * The daemon runs in a different process from the request that authenticated
 * the user (it reacts to Postgres NOTIFY, not an HTTP request), so the
 * originating identity arrives via `blocks.user_id` — stamped by the
 * `sendUserMessage` mutator from the verified JWT. Passing that id here sets
 * the same `distinct_id` the dashboard's `identify()` uses, so daemon events
 * merge into the same PostHog person; `$set` keeps email/name fresh on that
 * person. Every event carries `server_side: true` so daemon-emitted events
 * stay distinguishable from browser events in analysis. No-op without a key.
 */
export function captureFor(
  userId: string | null | undefined,
  event: string,
  properties: Record<string, unknown> = {},
): void {
  if (userId) {
    void resolveIdentity(userId).then((ident) => {
      const set =
        ident.email || ident.name ? { $set: { email: ident.email, name: ident.name } } : {};
      client.capture({
        distinctId: userId,
        event,
        properties: { ...properties, ...set, server_side: true },
      });
    });
    return;
  }
  client.capture({
    distinctId: SERVICE_DISTINCT_ID,
    event,
    properties: { ...properties, server_side: true },
  });
}

export { client as posthog, SERVICE_DISTINCT_ID as DISTINCT_ID };
