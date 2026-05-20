-- Item #52: server-computed unread badge counter.
--
-- AFTER INSERT trigger on `blocks`: when a non-user-authored block
-- lands for an agent, increment `unread_count` on every read_cursors
-- row for that agent (across all devices). The `markRead` mutator
-- resets unread_count=0 atomically with the last_seen_block_id
-- update, so the sidebar badge clears the moment a device sees the
-- new blocks.
--
-- Filter: only count blocks the user would perceive as "new content
-- from someone else." User-authored blocks (the user typing into
-- this agent's chat) shouldn't increment unread on the same agent.
-- The `role = 'assistant'` check covers the main case; mail-source
-- user blocks (`source = 'mail'`) also count as "agent-driven" so
-- they bump the badge.
CREATE OR REPLACE FUNCTION friday_blocks_increment_unread() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role = 'assistant'
     OR (NEW.role = 'user' AND NEW.source IN ('mail', 'agent_spawn', 'schedule'))
  THEN
    UPDATE "read_cursors"
    SET unread_count = unread_count + 1
    WHERE agent_name = NEW.agent_name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_blocks_increment_unread_trigger ON "blocks";
--> statement-breakpoint
CREATE TRIGGER friday_blocks_increment_unread_trigger
AFTER INSERT ON "blocks"
FOR EACH ROW
EXECUTE FUNCTION friday_blocks_increment_unread();
