-- Phase 4.4: flip ticket_comments.id from bigserial → text (UUID).
-- The Zero mutator framework requires the row's PK in the args so the
-- optimistic client write and the canonical server write target the
-- same row; bigserial's server-assigned values broke that contract.
--
-- USING id::text is required — Postgres can't auto-cast bigint to
-- text. After the type change we explicitly drop the now-orphan
-- sequence and install gen_random_uuid()::text as the default (so
-- legacy `addComment` REST calls that don't supply an id continue
-- to work).
ALTER TABLE "ticket_comments" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ticket_comments" ALTER COLUMN "id" SET DATA TYPE text USING "id"::text;--> statement-breakpoint
DROP SEQUENCE IF EXISTS "ticket_comments_id_seq";--> statement-breakpoint
ALTER TABLE "ticket_comments" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;
