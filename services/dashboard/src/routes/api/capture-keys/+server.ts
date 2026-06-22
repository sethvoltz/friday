import { json, type RequestHandler } from "@sveltejs/kit";
import { auth } from "$lib/server/auth";
import { logger } from "$lib/server/log";

/**
 * FRI-171 (ADR-047): session-gated management of Capture keys for the
 * Settings card (and the `friday capture-key` CLI, which proxies here).
 *
 * These are the AUTHENTICATED counterpart to `/api/capture` — every method
 * requires a logged-in session (`locals.user`), unlike the key-gated capture
 * endpoint. Operations:
 *   GET    → list the user's Capture keys (metadata only, never the secret).
 *   POST   → mint a new Capture key scoped `capture:["write"]`; the plaintext
 *            key is returned ONCE in the response and never recoverable after.
 *   DELETE → revoke a key by id (`?id=<keyId>`).
 *
 * IMPORTANT (1.6.9 plugin semantics):
 *  - `createApiKey` treats `permissions` (and `remaining`/rate-limit fields)
 *    as SERVER-ONLY: they may only be set on a trusted server-side call made
 *    WITHOUT request/headers, passing the owner via `body.userId`. Forwarding
 *    the session headers would 400 on the `permissions` field. So `POST` here
 *    relies on OUR own `locals.user` gate and then calls the plugin
 *    headerless with `userId` — the only path that can stamp the
 *    `capture:["write"]` scope.
 *  - `listApiKeys` / `deleteApiKey` run behind the plugin's `sessionMiddleware`
 *    (`ctx.context.session`) and scope to `session.user.id` — they take NO
 *    `userId`. They MUST be called with the request headers so the plugin
 *    resolves the session cookie. We forward `request.headers` for those.
 */

const CAPTURE_PERMISSIONS: Record<string, string[]> = { capture: ["write"] };

interface CaptureKeyView {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  enabled: boolean;
  createdAt: string;
  lastRequest: string | null;
  expiresAt: string | null;
}

/** Project a plugin key row down to the management-safe view (no secret). */
function toView(k: {
  id: string;
  name?: string | null;
  start?: string | null;
  prefix?: string | null;
  enabled?: boolean;
  createdAt: Date | string;
  lastRequest?: Date | string | null;
  expiresAt?: Date | string | null;
}): CaptureKeyView {
  const iso = (d: Date | string | null | undefined): string | null =>
    d == null ? null : d instanceof Date ? d.toISOString() : d;
  return {
    id: k.id,
    name: k.name ?? null,
    start: k.start ?? null,
    prefix: k.prefix ?? null,
    enabled: k.enabled ?? true,
    createdAt: iso(k.createdAt) ?? new Date(0).toISOString(),
    lastRequest: iso(k.lastRequest),
    expiresAt: iso(k.expiresAt),
  };
}

export const GET: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, { status: 401 });
  try {
    // Behind the plugin's sessionMiddleware — forward the request headers so
    // it resolves the session cookie and scopes to this user.
    const res = await auth.api.listApiKeys({ headers: request.headers });
    return json({ keys: (res.apiKeys ?? []).map(toView) });
  } catch (err) {
    logger.log("error", "capture-keys.list.error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "list_failed" }, { status: 500 });
  }
};

interface CreateBody {
  name?: unknown;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as CreateBody;
  const name =
    typeof body.name === "string" && body.name.trim().length > 0 ? body.name.trim() : "Capture key";
  try {
    // Server-side create with `userId` (NO headers) — the only path that may
    // stamp the server-only `permissions` scope. The plaintext `key` is
    // present on the create response and returned ONCE.
    const created = await auth.api.createApiKey({
      body: {
        userId: locals.user.id,
        name,
        prefix: "fcap_",
        permissions: CAPTURE_PERMISSIONS,
      },
    });
    return json({ key: created.key, view: toView(created) }, { status: 201 });
  } catch (err) {
    logger.log("error", "capture-keys.create.error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "create_failed" }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ request, url, locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, { status: 401 });
  const keyId = url.searchParams.get("id");
  if (!keyId) return json({ error: "id is required" }, { status: 400 });
  try {
    // Behind sessionMiddleware — forward the request headers. The plugin
    // verifies ownership against the session user (a foreign key 404s).
    await auth.api.deleteApiKey({ body: { keyId }, headers: request.headers });
    return json({ ok: true });
  } catch (err) {
    logger.log("warn", "capture-keys.delete.error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "delete_failed" }, { status: 500 });
  }
};
