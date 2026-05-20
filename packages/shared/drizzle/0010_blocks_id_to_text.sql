-- Phase 4.11 prep: flip blocks.id from bigserial → text (UUID).
-- The Zero mutator framework requires the row's PK in the args so
-- the optimistic client write and the canonical server write target
-- the same row; bigserial's server-assigned values broke that
-- contract for the upcoming `sendUserMessage` mutator. Mirrors the
-- 0003_overrated_arclight migration's ticket_comments flip.
--
-- USING id::text is required — Postgres can't auto-cast bigint to
-- text. After the type change we explicitly drop the now-orphan
-- sequence and install gen_random_uuid()::text as the default (so
-- legacy `recordUserBlock` callsites that don't supply an id
-- continue to work). Existing rows keep their integer-string ids
-- (e.g. "1", "2", "10"); chronological ordering across old + new
-- rows uses (ts, id) tuple compare since ts is the primary key
-- and the id tiebreak is only relevant within a single millisecond.
ALTER TABLE "blocks" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "blocks" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
DROP SEQUENCE IF EXISTS "blocks_id_seq";--> statement-breakpoint
ALTER TABLE "blocks" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;
