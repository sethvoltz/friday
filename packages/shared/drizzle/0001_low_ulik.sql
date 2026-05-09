CREATE TABLE `usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_name` text,
	`agent_type` text,
	`model` text,
	`cost_usd` real,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`turn_number` integer,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE INDEX `usage_session_ts` ON `usage` (`session_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `usage_agent_ts` ON `usage` (`agent_name`,`timestamp`);--> statement-breakpoint
CREATE INDEX `usage_ts` ON `usage` (`timestamp`);