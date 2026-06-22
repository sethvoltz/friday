import { json, type RequestHandler } from "@sveltejs/kit";
import { auth } from "$lib/server/auth";
import { daemonPostResult } from "$lib/server/daemon";
import { logger } from "$lib/server/log";

/**
 * FRI-171 (ADR-047): the stateless Capture intake endpoint.
 *
 * The Apple Watch Shortcut / PWA quick-add POSTs a raw Capture here with an
 * `x-api-key` Capture key — there is NO session cookie on this path, so
 * `/api/capture` is in `PUBLIC_PATHS` (it bypasses the session-redirect gate
 * in `hooks.server.ts`). The REAL guard is the per-key check below: a missing
 * or invalid key, or one lacking the `capture:["write"]` scope, gets a hard
 * 401 (never a 302→/login — a 302 would be followed by the caller's fetch and
 * land it on the login HTML, breaking `await r.json()`).
 *
 * On a valid key the Capture is proxied over loopback to the daemon's
 * `POST /api/intake` (same-host, `x-friday-daemon-secret`), which runs the
 * stateless classifier + Gate 1/Gate 2 + executor and returns the verdict.
 * The daemon NEVER drops a Capture: on classifier failure/timeout it still
 * writes a Proposed Inbox row, so the bell always reflects the Capture.
 *
 * The dashboard's daemon proxy has a 30s default timeout. We distinguish two
 * failure modes (FRI-171 review #3) — conflating them would lie to the caller:
 *   - TIMEOUT (daemon is up but slow): the daemon RECEIVED the Capture and its
 *     own intake path guarantees the item lands in the bell, so a 202 "queued"
 *     is the honest disposition (the caller need not retry).
 *   - TRANSPORT failure (daemon down / connection refused): the daemon NEVER
 *     received the Capture and no Inbox row was written — telling the caller
 *     "queued" would silently drop it. We return 503 so the Watch Shortcut /
 *     PWA can retry rather than lose the Capture.
 */

const CAPTURE_PERMISSIONS: Record<string, string[]> = { capture: ["write"] };
const API_KEY_HEADER = "x-api-key";

/** Capture provenance, mirrors the daemon's `IntakeSource` open-set. */
type CaptureSource = "watch" | "quick_add";

interface CaptureBody {
  text?: unknown;
  source?: unknown;
}

interface IntakeResponse {
  cleaned: string;
  disposition: "act" | "propose";
  rationale: string;
  kind: "done" | "proposed" | "unsorted";
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, { status: 401 });
}

export const POST: RequestHandler = async ({ request }) => {
  const key = request.headers.get(API_KEY_HEADER);
  if (!key) return unauthorized();

  // Verify the Capture key carries the `capture:["write"]` scope. This is a
  // session-less check (the apiKey plugin's verify endpoint requires no
  // cookie) — it hashes the presented key, looks it up, and asserts the
  // permission grant. `enableSessionForAPIKeys` is `false` in auth.ts, so a
  // valid key here mints NO session; this route never calls `getSession`.
  let verified: Awaited<ReturnType<typeof auth.api.verifyApiKey>>;
  try {
    verified = await auth.api.verifyApiKey({
      body: { key, permissions: CAPTURE_PERMISSIONS },
    });
  } catch (err) {
    logger.log("warn", "capture.verify.error", {
      message: err instanceof Error ? err.message : String(err),
    });
    return unauthorized();
  }
  if (!verified.valid) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as CaptureBody;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "text is required" }, { status: 400 });
  // `source` is an open set; the daemon coerces anything but "watch" to
  // "quick_add", so only those two are forwarded.
  const source: CaptureSource = body.source === "watch" ? "watch" : "quick_add";

  const outcome = await daemonPostResult<IntakeResponse>("/api/intake", { source, text });
  if (outcome.kind === "ok") {
    return json({
      cleaned: outcome.body.cleaned,
      disposition: outcome.body.disposition,
      rationale: outcome.body.rationale,
    });
  }
  if (outcome.kind === "rejected") {
    // The daemon answered with a 4xx/5xx (malformed body, internal error). The
    // Capture was received but not accepted; surface the daemon's status so the
    // caller doesn't treat a hard reject as "queued".
    logger.log("warn", "capture.intake.rejected", { status: outcome.status });
    return json({ error: "capture not accepted" }, { status: outcome.status });
  }
  if (outcome.kind === "timeout") {
    // Daemon is up but slow: it received the Capture and guarantees the item
    // lands in the bell, so a queued disposition is honest.
    logger.log("warn", "capture.intake.timeout", {});
    return json(
      { cleaned: text, disposition: "propose", rationale: "queued — intake still processing" },
      { status: 202 },
    );
  }
  // Transport failure: the daemon never received the Capture (no Inbox row was
  // written). Tell the caller to retry rather than silently drop it.
  logger.log("error", "capture.intake.transport", { message: outcome.error.message });
  return json({ error: "capture not accepted, retry" }, { status: 503 });
};
