import { PostHog } from "posthog-node";
import { eq } from "drizzle-orm";
import { getDb, loadFridayConfig, schema } from "@friday/shared";

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

// Build the client LAZILY, on first use — not at module load. POSTHOG_API_KEY
// is a daemon-scoped vault secret, and the daemon warms the age vault at boot
// (index.ts `warmVaultCache()`), which runs AFTER this module is imported.
// Reading the key at module load (the prior behavior) hit an unwarmed vault, so
// the client was built with an empty key and silently no-op'd all daemon
// analytics. Deferring the loadFridayConfig() read to first use guarantees it
// runs after the boot warm. (FRI-166 follow-up: vault-warm timing.)
let instance: PostHog | undefined;
function getClient(): PostHog {
  if (!instance) {
    const cfg = loadFridayConfig();
    instance = new PostHog(cfg.posthogApiKey ?? "", {
      host: cfg.posthogHost ?? DEFAULT_POSTHOG_HOST,
      enableExceptionAutocapture: true,
    });
  }
  return instance;
}

/**
 * Eagerly construct the client (after the vault is warmed). Called from daemon
 * boot so `enableExceptionAutocapture` installs its global handlers at startup
 * rather than waiting for the first capture.
 */
export function initPosthog(): void {
  getClient();
}

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
      getClient().capture({
        distinctId: userId,
        event,
        properties: { ...properties, ...set, server_side: true },
      });
    });
    return;
  }
  getClient().capture({
    distinctId: SERVICE_DISTINCT_ID,
    event,
    properties: { ...properties, server_side: true },
  });
}

// Lazy proxy: preserves `posthog.captureException(...)` / `.shutdown()` call
// sites (daemon index.ts) unchanged while deferring construction to first
// property access. Methods are bound to the underlying client.
const posthog = new Proxy({} as PostHog, {
  get(_target, prop) {
    const c = getClient();
    const value = Reflect.get(c, prop, c);
    return typeof value === "function" ? value.bind(c) : value;
  },
});

export { posthog, SERVICE_DISTINCT_ID as DISTINCT_ID };
