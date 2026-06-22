import { json, type RequestHandler } from "@sveltejs/kit";
import { daemonPostResult } from "$lib/server/daemon";
import { logger } from "$lib/server/log";

/**
 * FRI-171 (ADR-047): session-gated proxy that runs an Inbox Undo's inverse
 * executor server-side.
 *
 * The dashboard's Inbox store calls this BEFORE firing the `inboxUndo` Zero
 * mutator: it proxies over loopback to the daemon's `/api/intake/undo`, which
 * reverses the artifact the Done item created (delete the reminder / check-in /
 * memory), dispatched on the row's `target_id` + the artifact id parsed from
 * its `deep_link`. The inverse is daemon-only (it touches `deleteSchedule` /
 * `deleteCheckin` / `forgetEntry`). On success the client flips the row's
 * `state` resolved via the mutator.
 *
 * Not in `PUBLIC_PATHS` — `hooks.server.ts` requires a logged-in session here.
 */

interface UndoBody {
  id?: unknown;
}

interface UndoResult {
  ok: boolean;
  error?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as UndoBody;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return json({ error: "id is required" }, { status: 400 });
  const outcome = await daemonPostResult<UndoResult>("/api/intake/undo", { id });
  if (outcome.kind === "ok") return json(outcome.body);
  if (outcome.kind === "rejected") {
    // Relay the daemon's specific domain reason with its status.
    const body = (outcome.body ?? {}) as { ok?: boolean; error?: string };
    return json({ ok: false, error: body.error ?? "undo_failed" }, { status: outcome.status });
  }
  logger.log("warn", "intake.undo.proxy.error", {
    kind: outcome.kind,
    message: outcome.kind === "transport" ? outcome.error.message : "timeout",
  });
  return json({ ok: false, error: "undo_failed" }, { status: 502 });
};
