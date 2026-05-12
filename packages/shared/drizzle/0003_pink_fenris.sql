CREATE TABLE `blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`block_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text,
	`block_index` integer NOT NULL,
	`role` text NOT NULL,
	`kind` text NOT NULL,
	`source` text,
	`content_json` text NOT NULL,
	`status` text NOT NULL,
	`ts` integer NOT NULL,
	`last_event_seq` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocks_block_id_unique` ON `blocks` (`block_id`);--> statement-breakpoint
CREATE INDEX `blocks_agent_ts` ON `blocks` (`agent_name`,`ts`);--> statement-breakpoint
CREATE INDEX `blocks_session_msg` ON `blocks` (`session_id`,`message_id`,`block_index`);--> statement-breakpoint
CREATE INDEX `blocks_turn` ON `blocks` (`turn_id`);