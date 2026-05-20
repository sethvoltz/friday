-- Phase 4.9: blocks status='cancel_requested' + LISTEN/NOTIFY plumbing.
--
-- The `cancelQueued` mutator UPDATEs a queued block row's status from
-- 'queued' to 'cancel_requested'. A Postgres trigger fires
-- `NOTIFY friday_block_canceled` with the row's block_id; the daemon's
-- LISTEN handler:
--   1. Calls `removeQueuedPrompt(agent, turn)` to splice the in-memory
--      nextPrompts deque (idempotent — returns null if the fast-path
--      already spliced it).
--   2. Publishes a `block_meta_update` SSE event (legacy compatibility
--      so non-Zero tabs see the bubble disappear).
--   3. DELETEs the row.
--
-- The fast-path (`POST /api/internal/cancel-queued`) only splices
-- nextPrompts; it does NOT delete the row. The mutator UPDATEs the row
-- to 'cancel_requested', which fires the trigger; the LISTEN handler
-- then performs the canonical row DELETE. This gives us a single
-- canonical delete path while still meeting the user-facing latency
-- requirement (the splice happens synchronously via the fast-path).
--
-- Trigger predicate (NEW.status='cancel_requested') excludes:
--   - The daemon's DELETE (DELETE doesn't fire AFTER UPDATE).
--   - The legacy `DELETE /api/chat/turn/<id>/queued` REST path, which
--     DELETEs the row directly (no UPDATE = no trigger fire).
--   - Normal queued → dispatched / aborted lifecycle transitions.
--
-- Hand-authored migration — Drizzle can't introspect raw plpgsql.
ALTER TABLE "blocks" DROP CONSTRAINT IF EXISTS "blocks_status_check";--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_status_check" CHECK (
  "status" IN (
    'pending',
    'streaming',
    'complete',
    'aborted',
    'error',
    'queued',
    'abort_requested',
    'dispatched',
    'cancel_requested'
  )
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION friday_block_cancel_notify() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'cancel_requested' THEN
    PERFORM pg_notify('friday_block_canceled', NEW.block_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_block_cancel_notify_trigger ON "blocks";
--> statement-breakpoint
CREATE TRIGGER friday_block_cancel_notify_trigger
AFTER UPDATE ON "blocks"
FOR EACH ROW
EXECUTE FUNCTION friday_block_cancel_notify();
