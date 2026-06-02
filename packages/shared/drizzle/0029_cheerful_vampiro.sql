ALTER TABLE "schedules" ADD COLUMN "kind" text DEFAULT 'agent-run' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "delivery_json" jsonb;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_kind_check" CHECK ("schedules"."kind" IN ('agent-run','reminder'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION friday_blocks_increment_unread() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role = 'assistant'
     OR (NEW.role = 'user' AND NEW.source IN ('mail', 'agent_spawn', 'schedule', 'reminder'))
  THEN
    UPDATE "read_cursors"
    SET unread_count = unread_count + 1
    WHERE agent_name = NEW.agent_name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;