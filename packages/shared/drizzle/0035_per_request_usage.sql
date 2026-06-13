CREATE TABLE "usage_request" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"agent_name" text,
	"session_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"seq" integer NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "usage_request_agent_session_ts" ON "usage_request" USING btree ("agent_name","session_id","timestamp");--> statement-breakpoint
CREATE INDEX "usage_request_turn_seq" ON "usage_request" USING btree ("turn_id","seq");