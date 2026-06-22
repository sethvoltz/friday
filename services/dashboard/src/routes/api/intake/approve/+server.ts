import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonPostResult } from "$lib/server/daemon";
import { logger } from "$lib/server/log";

/**
 * FRI-171 (ADR-047): session-gated proxy that runs an Inbox Approve's executor
 * server-side.
 *
 * The dashboard's Inbox store calls this BEFORE firing the `inboxApprove` Zero
 * mutator: this proxies over loopback to the daemon's `/api/intake/approve`,
 * which re-validates the staged payload and runs the SAME Route-target executor
 * the intake act-path would have (the executor is daemon-only — it touches the
 * scheduler / habits / memory / tickets / mail primitives, none reachable from
 * the client bundle). On success the client flips the row's `state` resolved
 * via the mutator; on failure (409) the row stays Proposed and the UI surfaces
 * the error.
 *
 * Not in `PUBLIC_PATHS` — `hooks.server.ts` requires a logged-in session here
 * (a missing session → 401 JSON, never the capture-key path).
 */

interface ApproveBody {
  id?: unknown;
}

interface ApproveResult {
  ok: boolean;
  undoable?: boolean;
  inverseLabel?: string | null;
  deepLink?: string | null;
  error?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as ApproveBody;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return json({ error: "id is required" }, { status: 400 });
  const outcome = await daemonPostResult<ApproveResult>("/api/intake/approve", { id });
  if (outcome.kind === "ok") return json(outcome.body);
  if (outcome.kind === "rejected") {
    // A clean daemon domain rejection (e.g. 409 "payload no longer valid for
    // core:ticket"). Relay the daemon's own body + status so the specific
    // reason reaches the inbox store and the user — NOT a generic 502.
    const body = (outcome.body ?? {}) as { ok?: boolean; error?: string };
    return json({ ok: false, error: body.error ?? "approve_failed" }, { status: outcome.status });
  }
  // Timeout or transport failure — the daemon never produced a verdict.
  logger.log("warn", "intake.approve.proxy.error", {
    kind: outcome.kind,
    message: outcome.kind === "transport" ? outcome.error.message : "timeout",
  });
  return json({ ok: false, error: "approve_failed" }, { status: 502 });
};
