CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"name" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"session_id" text,
	"parent_name" text,
	"worktree_path" text,
	"branch" text,
	"ticket_id" text,
	"meta_json" jsonb,
	"spawn_reason" text,
	"app_id" text,
	"archive_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agents_type_check" CHECK ("agents"."type" IN ('orchestrator','builder','helper','scheduled','bare')),
	CONSTRAINT "agents_status_check" CHECK ("agents"."status" IN ('idle','working','stalled','error','archived','archive_requested'))
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"manifest_version" integer NOT NULL,
	"folder_path" text NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"installed_at" timestamp with time zone NOT NULL,
	"upgraded_at" timestamp with time zone,
	"meta_json" jsonb,
	CONSTRAINT "apps_status_check" CHECK ("apps"."status" IN ('installed','orphaned','error','pending_install','uninstall_requested','reload_requested'))
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"sha256" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"first_turn_id" text
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"block_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"block_index" integer NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"source" text,
	"content_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"streaming" boolean DEFAULT false NOT NULL,
	"origin_mutation_id" text,
	"ts" timestamp with time zone NOT NULL,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "blocks_block_id_unique" UNIQUE("block_id"),
	CONSTRAINT "blocks_role_check" CHECK ("blocks"."role" IN ('user','assistant','system')),
	CONSTRAINT "blocks_kind_check" CHECK ("blocks"."kind" IN ('text','thinking','tool_use','tool_result','error','mail')),
	CONSTRAINT "blocks_status_check" CHECK ("blocks"."status" IN ('pending','streaming','complete','aborted','error','queued','abort_requested','dispatched'))
);
--> statement-breakpoint
CREATE TABLE "client_devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"user_agent" text,
	"label" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"storage_used_bytes" integer,
	"storage_quota_bytes" integer,
	"last_sync_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "db_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"from_agent" text NOT NULL,
	"to_agent" text NOT NULL,
	"type" text NOT NULL,
	"delivery" text NOT NULL,
	"subject" text,
	"thread_id" text,
	"body" text NOT NULL,
	"meta_json" jsonb,
	"ts" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"priority" text DEFAULT 'normal' NOT NULL,
	"origin_mutation_id" text,
	CONSTRAINT "mail_priority_check" CHECK ("mail"."priority" IN ('normal','critical')),
	CONSTRAINT "mail_delivery_check" CHECK ("mail"."delivery" IN ('pending','delivered','read','closed'))
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"tags_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"file_mtime" timestamp with time zone NOT NULL,
	"recall_count" integer DEFAULT 0 NOT NULL,
	"last_recalled_at" timestamp with time zone,
	"status" text DEFAULT 'ready' NOT NULL,
	CONSTRAINT "memory_entries_status_check" CHECK ("memory_entries"."status" IN ('ready','pending_file','pending_delete','deleted'))
);
--> statement-breakpoint
CREATE TABLE "read_cursors" (
	"device_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"last_seen_block_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	CONSTRAINT "read_cursors_device_id_agent_name_pk" PRIMARY KEY("device_id","agent_name")
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"schedule_name" text NOT NULL,
	"fired_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"completed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "schedule_runs_status_check" CHECK ("schedule_runs"."status" IN ('running','complete','error'))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"name" text PRIMARY KEY NOT NULL,
	"cron" text,
	"run_at" text,
	"task_prompt" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_id" text,
	"meta_json" jsonb,
	"app_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "schedules_status_check" CHECK ("schedules"."status" IN ('active','pending_register','reload_requested','deleted','paused'))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "system_banners" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"text" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "system_banners_level_check" CHECK ("system_banners"."level" IN ('info','warn','error'))
);
--> statement-breakpoint
CREATE TABLE "ticket_comments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_external_links" (
	"ticket_id" text NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"meta_json" jsonb,
	"linked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ticket_external_links_ticket_id_system_external_id_pk" PRIMARY KEY("ticket_id","system","external_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_relations" (
	"parent_id" text NOT NULL,
	"child_id" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "ticket_relations_parent_id_child_id_kind_pk" PRIMARY KEY("parent_id","child_id","kind")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"status" text NOT NULL,
	"kind" text NOT NULL,
	"assignee" text,
	"meta_json" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tickets_status_check" CHECK ("tickets"."status" IN ('open','in_progress','done','blocked','closed'))
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"session_id" text NOT NULL,
	"agent_name" text,
	"agent_type" text,
	"model" text,
	"cost_usd" double precision,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"turn_number" integer,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "agents_type" ON "agents" USING btree ("type");--> statement-breakpoint
CREATE INDEX "agents_status" ON "agents" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "agents_app" ON "agents" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "blocks_agent_ts" ON "blocks" USING btree ("agent_name","ts");--> statement-breakpoint
CREATE INDEX "blocks_session_msg" ON "blocks" USING btree ("session_id","message_id","block_index");--> statement-breakpoint
CREATE INDEX "blocks_turn" ON "blocks" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "blocks_pending" ON "blocks" USING btree ("status","ts") WHERE "blocks"."status" IN ('pending','abort_requested');--> statement-breakpoint
CREATE INDEX "client_devices_user" ON "client_devices" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "mail_inbox" ON "mail" USING btree ("to_agent","delivery","ts");--> statement-breakpoint
CREATE INDEX "mail_thread" ON "mail" USING btree ("thread_id","ts");--> statement-breakpoint
CREATE INDEX "schedule_runs_schedule_ts" ON "schedule_runs" USING btree ("schedule_name","fired_at");--> statement-breakpoint
CREATE INDEX "schedules_next_run" ON "schedules" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "schedules_app" ON "schedules" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "system_banners_active" ON "system_banners" USING btree ("ts") WHERE "system_banners"."dismissed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ticket_comments_ticket" ON "ticket_comments" USING btree ("ticket_id","ts");--> statement-breakpoint
CREATE INDEX "ticket_external_by_system" ON "ticket_external_links" USING btree ("system","external_id");--> statement-breakpoint
CREATE INDEX "tickets_status" ON "tickets" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "tickets_assignee" ON "tickets" USING btree ("assignee");--> statement-breakpoint
CREATE INDEX "usage_session_ts" ON "usage" USING btree ("session_id","timestamp");--> statement-breakpoint
CREATE INDEX "usage_agent_ts" ON "usage" USING btree ("agent_name","timestamp");--> statement-breakpoint
CREATE INDEX "usage_ts" ON "usage" USING btree ("timestamp");