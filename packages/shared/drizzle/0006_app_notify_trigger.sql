-- Phase 4.7: Postgres trigger fires `NOTIFY friday_app_changed`
-- on INSERT/UPDATE when the apps row enters a status the daemon
-- needs to act on:
--   - pending_install: dashboard mutator wrote a stub row; daemon's
--     LISTEN handler reads the manifest from `folder_path`, runs
--     the existing transaction-wrapped installer (creates agents
--     + schedules), and flips status='installed'.
--   - uninstall_requested: dashboard mutator soft-set the request;
--     daemon archives owned agents, drops schedules, optionally
--     moves the folder, and DELETEs the row.
--   - reload_requested: dashboard mutator requested a re-read;
--     daemon re-reads the manifest from disk and reconciles.
--
-- Excludes 'installed' / 'orphaned' / 'error' from the predicate so
-- the daemon's own flip-back UPDATEs don't re-enter the handler.
-- Hand-authored — no schema change to introspect.
CREATE OR REPLACE FUNCTION friday_app_notify() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('pending_install', 'uninstall_requested', 'reload_requested') THEN
    PERFORM pg_notify('friday_app_changed', NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_app_notify_trigger ON "apps";
--> statement-breakpoint
CREATE TRIGGER friday_app_notify_trigger
AFTER INSERT OR UPDATE ON "apps"
FOR EACH ROW
EXECUTE FUNCTION friday_app_notify();
