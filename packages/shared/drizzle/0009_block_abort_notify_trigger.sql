-- Phase 4.10: blocks status='abort_requested' LISTEN/NOTIFY plumbing.
--
-- The `abortTurn` mutator UPDATEs the user block (the one whose
-- `turn_id` is the in-flight turn) from status='complete' to
-- status='abort_requested'. A Postgres trigger fires
-- `NOTIFY friday_abort_requested` with the row's block_id as payload;
-- the daemon's LISTEN handler:
--   1. Calls the existing `abortTurn(agentName)` lifecycle function
--      (sets `w.abortRequested=true`, sends `{type:'abort'}` IPC to
--      the worker, arms the 2s force-kill safety net). Idempotent if
--      the fast-path (`POST /api/internal/abort-turn`) already ran.
--   2. UPDATEs the row back to status='complete' (the natural
--      terminal state for a user block) so the trigger predicate
--      doesn't re-fire on subsequent unrelated UPDATEs.
--
-- The status enum already includes 'abort_requested' (since the
-- pre-Phase-4 schema reserved it for this exact flow — see
-- packages/shared/src/db/schema.ts:178 `pendingIdx` partial index),
-- so no check-constraint change is needed.
--
-- Trigger predicate (NEW.status='abort_requested') excludes:
--   - The legacy `POST /api/chat/turn/<id>/abort` REST path, which
--     never writes 'abort_requested' to a blocks row — it fires the
--     IPC directly and the worker's eventual turn_complete updates
--     the assistant block to 'aborted'.
--   - The daemon's flip-back UPDATE to 'complete' (handler-reentry
--     safety).
--
-- Hand-authored migration — Drizzle can't introspect raw plpgsql.
CREATE OR REPLACE FUNCTION friday_block_abort_notify() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'abort_requested' THEN
    PERFORM pg_notify('friday_abort_requested', NEW.block_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_block_abort_notify_trigger ON "blocks";
--> statement-breakpoint
CREATE TRIGGER friday_block_abort_notify_trigger
AFTER UPDATE ON "blocks"
FOR EACH ROW
EXECUTE FUNCTION friday_block_abort_notify();
