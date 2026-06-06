CREATE TABLE IF NOT EXISTS "secrets_fetch_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"secret_name" text NOT NULL,
	"caller_name" text NOT NULL,
	"caller_type" text NOT NULL,
	"app_id" text,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"ts" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_fetch_log_source_check" CHECK ("source" IN ('mcp', 'cli'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secrets_fetch_log_caller_ts_idx" ON "secrets_fetch_log" USING btree ("caller_name","ts");
