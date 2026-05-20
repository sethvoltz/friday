-- Phase 4.8: Postgres trigger fires `NOTIFY friday_archive_requested`
-- on UPDATE when an agent's status transitions to 'archive_requested'.
-- The daemon's LISTEN handler reads the row's `archive_reason`,
-- calls the existing `archiveAgent(name, {reason})` lifecycle
-- function (which kills the worker + archives the worktree + closes
-- linked tickets), and lets the lifecycle code flip the row to
-- 'archived' as its final write.
--
-- The trigger fires ONLY on the explicit 'archive_requested'
-- transition — the daemon's own writes (registry.archiveAgent
-- setting status='archived' at the tail of the lifecycle call)
-- don't re-enter. The legacy `/api/commands` archive path bypasses
-- this trigger entirely (calls `archiveAgent` directly) — the row
-- goes idle → archived without passing through 'archive_requested'.
--
-- Hand-authored migration — no schema change to introspect.
CREATE OR REPLACE FUNCTION friday_archive_notify() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'archive_requested' THEN
    PERFORM pg_notify('friday_archive_requested', NEW.name);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_archive_notify_trigger ON "agents";
--> statement-breakpoint
CREATE TRIGGER friday_archive_notify_trigger
AFTER UPDATE ON "agents"
FOR EACH ROW
EXECUTE FUNCTION friday_archive_notify();
