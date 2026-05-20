-- Phase 4.5: Postgres trigger fires `NOTIFY friday_memory_file_changed`
-- on INSERT/UPDATE when the row's status is pending_file or
-- pending_delete. The daemon's LISTEN handler reads the row, writes
-- or moves the markdown file, then flips status to 'ready' or
-- 'deleted'. Boot recovery scans the same predicate on daemon
-- startup so changes that landed while the daemon was down apply
-- on next boot (plan §5: every LISTEN handler has a matching
-- boot-recovery scan with the same predicate).
--
-- AFTER INSERT OR UPDATE: a fresh INSERT with status='pending_file'
-- (createMemoryEntry) and an UPDATE-status (updateMemoryEntry,
-- deleteMemoryEntry) both fire. Hand-authored migration: no schema
-- change to introspect, drizzle-kit had nothing to emit.
CREATE OR REPLACE FUNCTION friday_memory_notify() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('pending_file', 'pending_delete') THEN
    PERFORM pg_notify('friday_memory_file_changed', NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS friday_memory_notify_trigger ON "memory_entries";
--> statement-breakpoint
CREATE TRIGGER friday_memory_notify_trigger
AFTER INSERT OR UPDATE ON "memory_entries"
FOR EACH ROW
EXECUTE FUNCTION friday_memory_notify();
