-- Phase 4.11b: blocks status='pending' LISTEN/NOTIFY plumbing for the
-- `sendUserMessage` mutator.
--
-- The dashboard's mutator INSERTs a user-chat block with status='pending'
-- (the discriminator — daemon-internal writes never use this status; user
-- blocks land at 'complete' or 'queued'). A Postgres trigger fires
-- `NOTIFY friday_new_pending_block` with NEW.id as payload; the daemon's
-- LISTEN handler:
--   1. Reads the row.
--   2. Resolves the target agent (registers as orchestrator if missing).
--   3. Composes the system prompt, detects skill invocation, wraps with
--      memory recall.
--   4. Peeks the live worker to decide queued-vs-immediate dispatch.
--   5. UPDATEs the row's status to 'queued' (worker mid-turn) or
--      'complete' (clean dispatch).
--   6. Calls `dispatchTurn` to fork or queue the prompt.
--
-- Trigger fires AFTER INSERT only — the daemon's flip-out to
-- 'queued'/'complete' is an UPDATE and must not re-enter the handler.
--
-- Hand-authored migration — Drizzle can't introspect raw plpgsql.
CREATE OR REPLACE FUNCTION friday_block_dispatch_notify() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM pg_notify('friday_new_pending_block', NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_block_dispatch_notify_trigger ON "blocks";
--> statement-breakpoint
CREATE TRIGGER friday_block_dispatch_notify_trigger
AFTER INSERT ON "blocks"
FOR EACH ROW
EXECUTE FUNCTION friday_block_dispatch_notify();
