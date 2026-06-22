import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonPostResult } from "$lib/server/daemon";
import { logger } from "$lib/server/log";

/**
 * FRI-171 (ADR-047): session-gated proxy that triages an Unsorted item to a
 * chosen `agent:<name>` Route target.
 *
 * Proxies over loopback to the daemon's `/api/intake/triage`, which mails the
 * item's cleaned text to the chosen agent (the mail executor is daemon-only)
 * and promotes the row to Done. The client then flips state via the
 * `inboxApprove` mutator (the row is now Done and resolved).
 *
 * Not in `PUBLIC_PATHS` — requires a logged-in session.
 */

interface TriageBody {
  id?: unknown;
  targetId?: unknown;
}

interface TriageResult {
  ok: boolean;
  undoable?: boolean;
  inverseLabel?: string | null;
  deepLink?: string | null;
  error?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as TriageBody;
  const id = typeof body.id === "string" ? body.id : "";
  const targetId = typeof body.targetId === "string" ? body.targetId : "";
  if (!id || !targetId) return json({ error: "id and targetId are required" }, { status: 400 });
  const outcome = await daemonPostResult<TriageResult>("/api/intake/triage", { id, targetId });
  if (outcome.kind === "ok") return json(outcome.body);
  if (outcome.kind === "rejected") {
    // Relay the daemon's specific domain reason (e.g. "target unavailable")
    // with its status instead of flattening to a generic 502.
    const body = (outcome.body ?? {}) as { ok?: boolean; error?: string };
    return json({ ok: false, error: body.error ?? "triage_failed" }, { status: outcome.status });
  }
  logger.log("warn", "intake.triage.proxy.error", {
    kind: outcome.kind,
    message: outcome.kind === "transport" ? outcome.error.message : "timeout",
  });
  return json({ ok: false, error: "triage_failed" }, { status: 502 });
};
