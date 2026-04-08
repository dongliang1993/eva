CREATE TABLE `local_agent_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_key` text NOT NULL,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`instruction` text NOT NULL,
	`provider_preference` text DEFAULT 'auto' NOT NULL,
	`assigned_provider` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_message_id` text,
	`branch_name` text,
	`worktree_path` text,
	`report` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_local_agent_issues_issue_key` ON `local_agent_issues` (`issue_key`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_issues_session_id` ON `local_agent_issues` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_issues_status` ON `local_agent_issues` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_issues_updated_at` ON `local_agent_issues` (`updated_at`);
--> statement-breakpoint
CREATE TABLE `local_agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`provider` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`system_prompt` text DEFAULT '' NOT NULL,
	`report` text DEFAULT '' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`external_session_id` text,
	`branch_name` text,
	`worktree_path` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `local_agent_issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_runs_issue_id` ON `local_agent_runs` (`issue_id`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_runs_status` ON `local_agent_runs` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_local_agent_runs_created_at` ON `local_agent_runs` (`created_at`);
