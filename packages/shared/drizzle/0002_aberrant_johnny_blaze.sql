CREATE TABLE "settings" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text,
	"watchdog_refork" boolean,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Seed the singleton row. The `updateSettings` mutator UPSERTs by
-- `id = 'singleton'`; pre-creating the row ensures the daemon's
-- boot-recovery scan + the dashboard's reactive query both have
-- something to read on first run (model/watchdog stay NULL until
-- the user updates them, at which point they shadow config.json).
INSERT INTO "settings" ("id", "updated_at") VALUES ('singleton', NOW())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- Trigger fires `NOTIFY friday_settings_changed` on every UPDATE,
-- whether from the `updateSettings` mutator OR a daemon-internal
-- writer. Daemon's LISTEN handler resyncs ~/.friday/config.json on
-- each notification; matching boot-recovery scan reconciles on
-- startup (plan §5). Trigger uses `AFTER UPDATE` so the notification
-- is delivered only on committed transactions — a rolled-back UPDATE
-- doesn't fire spurious notifications.
CREATE OR REPLACE FUNCTION friday_settings_notify() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('friday_settings_changed', NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_settings_notify_trigger ON "settings";
--> statement-breakpoint
CREATE TRIGGER friday_settings_notify_trigger
AFTER UPDATE ON "settings"
FOR EACH ROW
EXECUTE FUNCTION friday_settings_notify();
