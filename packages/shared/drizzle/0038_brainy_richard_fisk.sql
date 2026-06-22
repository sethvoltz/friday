CREATE TABLE "inbox_items" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"raw_text" text NOT NULL,
	"cleaned_text" text,
	"target_id" text,
	"payload" jsonb,
	"rationale" text,
	"kind" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"undoable" boolean DEFAULT false NOT NULL,
	"inverse_label" text,
	"deep_link" text,
	CONSTRAINT "inbox_items_kind_check" CHECK ("inbox_items"."kind" IN ('done','proposed','unsorted')),
	CONSTRAINT "inbox_items_state_check" CHECK ("inbox_items"."state" IN ('open','resolved'))
);
--> statement-breakpoint
CREATE INDEX "inbox_items_state_created" ON "inbox_items" USING btree ("state","created_at");