CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`token_usage` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_session_id` ON `messages` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_created_at` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'New Chat' NOT NULL,
	`session_key` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_session_key` ON `sessions` (`session_key`);--> statement-breakpoint
CREATE INDEX `idx_sessions_updated_at` ON `sessions` (`updated_at`);