-- Item #53: extend `friday_schedule_notify` so the daemon's
-- scheduler-listener fires on `trigger_requested` too. The new
-- `triggerSchedule` mutator (alongside pauseSchedule + resumeSchedule)
-- writes status='trigger_requested'; the daemon listener picks it up,
-- calls `fireSchedule(schedule)`, then flips status back to 'active'.
--
-- Same predicate-extension shape as the original Phase 4.6 trigger;
-- AFTER INSERT OR UPDATE; the daemon's own flip-back to 'active' is
-- still excluded so the handler doesn't re-enter.
CREATE OR REPLACE FUNCTION friday_schedule_notify() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('pending_register', 'reload_requested', 'deleted', 'trigger_requested') THEN
    PERFORM pg_notify('friday_schedule_changed', NEW.name);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
