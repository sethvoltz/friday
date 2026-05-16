CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`manifest_version` integer NOT NULL,
	`folder_path` text NOT NULL,
	`manifest_json` text NOT NULL,
	`status` text NOT NULL,
	`installed_at` integer NOT NULL,
	`upgraded_at` integer,
	`meta_json` text
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `app_id` text;--> statement-breakpoint
CREATE INDEX `agents_app` ON `agents` (`app_id`);--> statement-breakpoint
ALTER TABLE `schedules` ADD `app_id` text;--> statement-breakpoint
CREATE INDEX `schedules_app` ON `schedules` (`app_id`);