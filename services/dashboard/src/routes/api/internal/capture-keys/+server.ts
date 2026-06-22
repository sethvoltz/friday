import { json, type RequestHandler } from "@sveltejs/kit";
import { DAEMON_SECRET_HEADER, getDaemonSecret } from "@friday/shared";
import {
  listCaptureKeysForUser,
  resolveSoleUserId,
  revokeCaptureKey,
  type CaptureKeyRow,
} from "@friday/shared/services";
import { auth } from "$lib/server/auth";
import { logger } from "$lib/server/log";

/**
 * FRI-171 (ADR-047): loopback + daemon-secret-gated Capture-key management
 * for the `friday capture-key` CLI.
 *
 * The CLI runs on the same host as the dashboard but has NO BetterAuth
 * session cookie — it authenticates to local services with the shared
 * daemon secret (`x-friday-daemon-secret`), the same way it reaches the
 * daemon. The session-gated `/api/capture-keys` route (the Settings card)
 * is therefore unreachable from the CLI; this is its loopback twin.
 *
 * Two gates protect it:
 *   1. `hooks.server.ts` only exempts it from the session redirect when the
 *      request originates from 127.0.0.1 / ::1 (`LOOPBACK_ONLY_PATHS`).
 *   2. Every method here additionally requires a constant-secret match on
 *      `x-friday-daemon-secret` — the same secret the daemon expects, which
 *      only same-host processes (the CLI, the daemon) can read off disk.
 *
 * Capture keys belong to the single Friday account (public sign-up is
 * permanently disabled — the sole account is created by `friday setup`), so
 * operations resolve that one `user` row rather than a session user:
 *   GET    → list that user's Capture keys (metadata only, never the secret).
 *   POST   → mint a Capture key scoped `capture:["write"]`; the plaintext key
 *            is returned ONCE and never recoverable after.
 *   DELETE → revoke a key by id (`?id=<keyId>`) by disabling it — preserve-
 *            over-delete: the row stays for audit, the key stops verifying.
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

const isoMs = (ms: number | null): string | null =>
  ms == null ? null : new Date(ms).toISOString();

/** Project a service row to the wire view consumed by the CLI / Settings. */
function rowToView(r: CaptureKeyRow): CaptureKeyView {
  return {
    id: r.id,
    name: r.name,
    start: r.start,
    prefix: r.prefix,
    enabled: r.enabled,
    createdAt: isoMs(r.createdAt) ?? new Date(0).toISOString(),
    lastRequest: isoMs(r.lastRequestAt),
    expiresAt: isoMs(r.expiresAt),
  };
}

/** Project the BetterAuth create-response key down to the wire view. */
function createdToView(k: {
  id: string;
  name?: string | null;
  start?: string | null;
  prefix?: string | null;
  enabled?: boolean | null;
  createdAt: Date | string;
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
    lastRequest: null,
    expiresAt: iso(k.expiresAt),
  };
}

/** Constant-secret gate: same shared secret the daemon uses. */
function authorized(request: Request): boolean {
  const presented = request.headers.get(DAEMON_SECRET_HEADER);
  if (!presented) return false;
  try {
    const expected = getDaemonSecret();
    // Length-mismatch short-circuits; both are hex secrets of equal length
    // under normal operation, so this is not a meaningful oracle.
    if (presented.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

export const GET: RequestHandler = async ({ request }) => {
  if (!authorized(request)) return json({ error: "unauthorized" }, { status: 401 });
  try {
    const userId = await resolveSoleUserId();
    if (!userId) return json({ keys: [] });
    const rows = await listCaptureKeysForUser(userId);
    return json({ keys: rows.map(rowToView) });
  } catch (err) {
    logger.log("error", "capture-keys.internal.list.error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "list_failed" }, { status: 500 });
  }
};

interface CreateBody {
  name?: unknown;
}

export const POST: RequestHandler = async ({ request }) => {
  if (!authorized(request)) return json({ error: "unauthorized" }, { status: 401 });
  const userId = await resolveSoleUserId();
  if (!userId) return json({ error: "no_account" }, { status: 409 });
  const body = (await request.json().catch(() => ({}))) as CreateBody;
  const name =
    typeof body.name === "string" && body.name.trim().length > 0 ? body.name.trim() : "Capture key";
  try {
    // Server-side create with `userId` (NO headers) — the only path that may
    // stamp the server-only `permissions` scope (the 1.6.9 plugin rejects
    // `permissions` on a request-bearing call). The plaintext `key` is
    // present on the create response and returned ONCE.
    const created = await auth.api.createApiKey({
      body: {
        userId,
        name,
        prefix: "fcap_",
        permissions: CAPTURE_PERMISSIONS,
      },
    });
    return json({ key: created.key, view: createdToView(created) }, { status: 201 });
  } catch (err) {
    logger.log("error", "capture-keys.internal.create.error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "create_failed" }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ request, url }) => {
  if (!authorized(request)) return json({ error: "unauthorized" }, { status: 401 });
  const keyId = url.searchParams.get("id");
  if (!keyId) return json({ error: "id is required" }, { status: 400 });
  try {
    const userId = await resolveSoleUserId();
    if (!userId) return json({ error: "no_account" }, { status: 409 });
    const ok = await revokeCaptureKey(userId, keyId);
    if (!ok) return json({ error: "not_found" }, { status: 404 });
    return json({ ok: true });
  } catch (err) {
    logger.log("warn", "capture-keys.internal.delete.error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "delete_failed" }, { status: 500 });
  }
};
