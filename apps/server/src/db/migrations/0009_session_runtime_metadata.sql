-- Add runtime metadata columns to sessions
ALTER TABLE `sessions` ADD COLUMN `model` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `reasoning_effort` text NOT NULL DEFAULT 'medium';
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `origin` text NOT NULL DEFAULT 'chat';
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `tool_policy` text NOT NULL DEFAULT 'auto';
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `skill_policy` text NOT NULL DEFAULT 'auto';
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `memory_policy` text NOT NULL DEFAULT 'auto';
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `metadata` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE INDEX `idx_sessions_origin` ON `sessions` (`origin`);
