CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`thread_id` text,
	`message_id` text,
	`user_id` text DEFAULT 'default' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_memories_user_id` ON `memories` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_created_at` ON `memories` (`created_at`);