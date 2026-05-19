-- Phase 4.6: Postgres trigger fires `NOTIFY friday_schedule_changed`
-- on INSERT/UPDATE when a schedule's status enters a state the
-- daemon needs to act on:
--   - pending_register: new schedule from dashboard mutator → daemon
--     registers the agent stub, computes nextRunAt from the cron
--     expression, flips status='active'.
--   - reload_requested: cron/runAt updated → daemon recomputes
--     nextRunAt, flips status='active'.
--   - deleted: dashboard soft-delete → daemon cleans up the
--     registry stub if unused; row stays at 'deleted' as a
--     tombstone (multi-device sync's negative-presence signal).
--
-- Same shape as the memory + settings notify triggers from Phase
-- 4.3 / 4.5: AFTER INSERT OR UPDATE with a status-predicate guard.
-- Crucially excludes 'active' and 'paused' from the predicate so
-- the daemon's own flip-back UPDATE doesn't re-enter the handler.
-- Hand-authored migration: no schema change to introspect.
CREATE OR REPLACE FUNCTION friday_schedule_notify() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('pending_register', 'reload_requested', 'deleted') THEN
    PERFORM pg_notify('friday_schedule_changed', NEW.name);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_schedule_notify_trigger ON "schedules";
--> statement-breakpoint
CREATE TRIGGER friday_schedule_notify_trigger
AFTER INSERT OR UPDATE ON "schedules"
FOR EACH ROW
EXECUTE FUNCTION friday_schedule_notify();
