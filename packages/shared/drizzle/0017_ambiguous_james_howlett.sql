CREATE TABLE "evolve_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"proposal_type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"cluster_id" text,
	"score" double precision DEFAULT 0 NOT NULL,
	"blast_radius" text DEFAULT 'low' NOT NULL,
	"applies_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_by" text,
	"enriched_at" timestamp with time zone,
	"enriched_by" text,
	"last_enrich_error" text,
	"last_enrich_failed_at" timestamp with time zone,
	"applied_ticket_id" text
);
--> statement-breakpoint
CREATE INDEX "evolve_proposals_status_updated" ON "evolve_proposals" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "evolve_proposals_cluster" ON "evolve_proposals" USING btree ("cluster_id");