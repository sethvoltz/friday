CREATE TABLE "_friday_state_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta_json" jsonb
);
