-- 工作区(docs 15 §S3)。列只建现在有读取方的 —— worktree / PR 相关列留给 S9,
-- 现在建等于给 T10 正在删的死列再添几个。
CREATE TABLE IF NOT EXISTS `workspaces` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `path` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
-- 同一个目录不允许重复添加:否则"当前工作区"下拉框里出现两个同名项,
-- 用户无法分辨,而它们的 tool-overflow 目录却是分开的。
CREATE UNIQUE INDEX IF NOT EXISTS `idx_workspaces_path` ON `workspaces` (`path`);
--> statement-breakpoint
-- 会话绑定工作区;NULL = 该会话没有文件能力(合法状态)。
ALTER TABLE `sessions` ADD COLUMN `workspace_id` text REFERENCES `workspaces`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_workspace_id` ON `sessions` (`workspace_id`);