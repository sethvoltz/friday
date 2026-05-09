ALTER TABLE `mail` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `mail` ADD `thread_id` text;--> statement-breakpoint
CREATE INDEX `mail_thread` ON `mail` (`thread_id`,`ts`);