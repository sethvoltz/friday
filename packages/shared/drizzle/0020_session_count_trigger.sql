-- Maintains `agents.session_count` as the count of distinct `session_id`
-- values seen across that agent's `blocks` rows. Backs the sidebar's
-- expand-history button: after ADR-024 retired the REST `/api/agents`
-- poll, the column has to ride Zero replication if the `+` glyph is
-- ever going to render — a per-row `COUNT(DISTINCT)` from the dashboard
-- doesn't fit the live-streamed agents row shape.
--
-- AFTER INSERT trigger on `blocks`: when the inserted row's session_id
-- is novel for that agent (no prior block carries the same
-- (agent_name, session_id) pair), bump `agents.session_count` by 1.
-- Otherwise no-op. Recomputing `COUNT(DISTINCT)` per insert would scan
-- every block for the agent — fine on a fresh DB, painful once the
-- orchestrator has a year of chat — so we lean on the (cheap) NOT EXISTS
-- lookup against the `blocks_session_msg` index instead.
--
-- No DELETE handler: blocks are preserve-over-delete (project policy).
-- If that ever changes, this trigger needs a sibling that decrements
-- when the last block of a (agent_name, session_id) pair goes away.
--
-- One-time backfill for rows that pre-date the trigger:
UPDATE "agents" a
SET session_count = (
  SELECT COUNT(DISTINCT b.session_id)::int
  FROM "blocks" b
  WHERE b.agent_name = a.name
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION friday_blocks_increment_session_count() RETURNS TRIGGER AS $$
BEGIN
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
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_blocks_increment_session_count_trigger ON "blocks";
--> statement-breakpoint
CREATE TRIGGER friday_blocks_increment_session_count_trigger
AFTER INSERT ON "blocks"
FOR EACH ROW
EXECUTE FUNCTION friday_blocks_increment_session_count();
