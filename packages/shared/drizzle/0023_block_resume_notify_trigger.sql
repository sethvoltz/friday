ALTER TABLE "blocks" DROP CONSTRAINT "blocks_status_check";--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_status_check" CHECK ("blocks"."status" IN ('pending','streaming','complete','aborted','error','queued','abort_requested','dispatched','cancel_requested','resume_requested'));--> statement-breakpoint
-- FRI-123: blocks status='resume_requested' LISTEN/NOTIFY plumbing.
--
-- The `resumeTurn` mutator UPDATEs the user block (the one whose
-- `turn_id` is the failed turn's id) from status='complete' to
-- status='resume_requested'. A Postgres trigger fires
-- `NOTIFY friday_resume_requested` with the row's block_id as
-- payload; the daemon's resume-listener handler:
--   1. Reads the block by id and validates (agent exists; no live
--      turn for this agent; user block content_json parses).
--   2. Calls `buildDispatchPrompt(agentRow, {kind:'user_chat'})` to
--      rebuild the prompt under the FRI-12 visual-grouping contract.
--   3. Calls `dispatchTurn` re-using the existing `turnId` so the
--      retry's content blocks visually group with the error bubble.
--   4. UPDATEs the row back to status='complete' (the natural
--      terminal state for a user block) so the trigger doesn't
--      re-fire on subsequent unrelated UPDATEs.
--
-- Drizzle-kit emitted the constraint update above from the schema
-- diff; the trigger plumbing below is hand-authored (drizzle can't
-- introspect raw plpgsql) and shares this migration so the enum
-- extension + trigger land atomically.
--
-- Trigger predicate (NEW.status='resume_requested') excludes:
--   - The retired `POST /api/chat/turn/<id>/resume` REST path
--     (deleted in this PR) — never wrote 'resume_requested' to a
--     blocks row; it fired dispatchTurn directly with the reused
--     turnId.
--   - The daemon's flip-back UPDATE to 'complete' (handler-reentry
--     safety, mirroring the abort trigger).
CREATE OR REPLACE FUNCTION friday_block_resume_notify() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'resume_requested' THEN
    PERFORM pg_notify('friday_resume_requested', NEW.block_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_block_resume_notify_trigger ON "blocks";
--> statement-breakpoint
CREATE TRIGGER friday_block_resume_notify_trigger
AFTER UPDATE ON "blocks"
FOR EACH ROW
EXECUTE FUNCTION friday_block_resume_notify();
