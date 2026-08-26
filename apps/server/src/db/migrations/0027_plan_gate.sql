-- T45a:Plan Gate 的 session 级规划态。plan 文件在 workspace 的 .eva/plan-gate/ 下。
CREATE TABLE `plans` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `workspace_id` text NOT NULL,
  `path` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `revision_count` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_plans_session_status` ON `plans` (`session_id`, `status`);
