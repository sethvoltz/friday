-- Teach the session-count trigger about the `__pending__` sentinel.
--
-- The dashboard's `sendUserMessage` mutator writes user blocks with
-- `session_id = '__pending__'` because the SDK hasn't minted a real
-- session id yet (the daemon owns the boundary). The daemon's
-- `claimPendingSession` sweep — called from the lifecycle
-- `session-update` handler — UPDATEs those rows to the real id once
-- the worker announces a session.
--
-- Before this migration, every `__pending__` INSERT bumped
-- `agents.session_count` as if a brand-new session had started,
-- inflating the sidebar's expand-history gate. The fix:
--
--   1. Trigger function skips the bump when NEW.session_id is the
--      sentinel. The sentinel is a "no session yet" marker, not a
--      real session.
--   2. The sweep (`claimPendingSession`) re-derives session_count
--      from `COUNT(DISTINCT session_id) WHERE session_id != sentinel`
--      and writes it directly on the agents row — sidestepping the
--      AFTER UPDATE trigger ordering question entirely (when the
--      sweep UPDATEs multiple rows in one statement, each row's
--      AFTER ROW trigger would see prior rows already rewritten and
--      under-count).
--
-- One-time backfill: recompute `session_count` for every agent using
-- the same exclusion rule. Historical `__pending__` orphans that
-- pre-date this migration stay in the `blocks` table
-- (preserve-over-delete) but no longer count toward the sidebar's
-- expand-history gate.
UPDATE "agents" a
SET session_count = (
  SELECT COUNT(DISTINCT b.session_id)::int
  FROM "blocks" b
  WHERE b.agent_name = a.name
    AND b.session_id <> '__pending__'
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION friday_blocks_increment_session_count() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.session_id = '__pending__' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "blocks"
    WHERE agent_name = NEW.agent_name
      AND session_id = NEW.session_id
      AND id <> NEW.id
  ) THEN
    UPDATE "agents"
    SET session_count = session_count + 1
    WHERE name = NEW.agent_name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
