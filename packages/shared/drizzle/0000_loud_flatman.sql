CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`name` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`session_id` text,
	`parent_name` text,
	`worktree_path` text,
	`branch` text,
	`ticket_id` text,
	`meta_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_type` ON `agents` (`type`);--> statement-breakpoint
CREATE INDEX `agents_status` ON `agents` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`sha256` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uploaded_at` integer NOT NULL,
	`first_turn_id` integer
);
--> statement-breakpoint
CREATE TABLE `db_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mail` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_agent` text NOT NULL,
	`to_agent` text NOT NULL,
	`type` text NOT NULL,
	`delivery` text NOT NULL,
	`body` text NOT NULL,
	`meta_json` text,
	`ts` integer NOT NULL,
	`read_at` integer,
	`closed_at` integer
);
--> statement-breakpoint
CREATE INDEX `mail_inbox` ON `mail` (`to_agent`,`delivery`,`ts`);--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`file_mtime` integer NOT NULL,
	`recall_count` integer DEFAULT 0 NOT NULL,
	`last_recalled_at` text
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`name` text PRIMARY KEY NOT NULL,
	`cron` text,
	`run_at` text,
	`task_prompt` text NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_run_id` text,
	`meta_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `schedules_next_run` ON `schedules` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `ticket_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_id` text NOT NULL,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ticket_comments_ticket` ON `ticket_comments` (`ticket_id`,`ts`);--> statement-breakpoint
CREATE TABLE `ticket_external_links` (
	`ticket_id` text NOT NULL,
	`system` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text,
	`meta_json` text,
	`linked_at` integer NOT NULL,
	PRIMARY KEY(`ticket_id`, `system`, `external_id`)
);
--> statement-breakpoint
CREATE INDEX `ticket_external_by_system` ON `ticket_external_links` (`system`,`external_id`);--> statement-breakpoint
CREATE TABLE `ticket_relations` (
	`parent_id` text NOT NULL,
	`child_id` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`parent_id`, `child_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`status` text NOT NULL,
	`kind` text NOT NULL,
	`assignee` text,
	`meta_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tickets_status` ON `tickets` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `tickets_assignee` ON `tickets` (`assignee`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`agent_name` text,
	`turn_index` integer NOT NULL,
	`ts` integer NOT NULL,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`content_json` text NOT NULL,
	`source_file` text NOT NULL,
	`source_byte_off` integer NOT NULL,
	`last_event_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_session_turn` ON `turns` (`session_id`,`turn_index`);--> statement-breakpoint
CREATE INDEX `turns_agent_ts` ON `turns` (`agent_name`,`ts`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer,
	`updatedAt` integer
);
