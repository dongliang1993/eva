CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`decided_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_approval_requests_session` ON `approval_requests` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_status` ON `approval_requests` (`status`);