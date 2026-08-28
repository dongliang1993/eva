-- T48:runs 补父子关系与失败归因(全部可空,老行不回填)。
-- parent_run_id 自引用级联:删除父 Run 时后台子 Run 一起走(T48 retention 的
-- 「按引用一起清理」靠它结构保证)。
ALTER TABLE `runs` ADD COLUMN `parent_run_id` text REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `background_task_id` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `requested_model` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `failure_layer` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `capture_level` text;
--> statement-breakpoint
CREATE INDEX `idx_runs_parent_run_id` ON `runs` (`parent_run_id`);
--> statement-breakpoint
CREATE INDEX `idx_runs_background_task_id` ON `runs` (`background_task_id`);
--> statement-breakpoint
-- usage_records 重建:去掉 runs 外键。retention 整 Run 粒度删除(设计文档 §7.1),
-- 留着这个 FK 会把聚合台账跟着级联清空 —— usage 的保留策略独立(会话级联仍保留)。
CREATE TABLE `__new_usage_records` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
  `model` text,
  `date` text NOT NULL,
  `input_tokens` integer NOT NULL DEFAULT 0,
  `output_tokens` integer NOT NULL DEFAULT 0,
  `reasoning_tokens` integer NOT NULL DEFAULT 0,
  `cached_input_tokens` integer NOT NULL DEFAULT 0,
  `cache_write_input_tokens` integer NOT NULL DEFAULT 0,
  `total_tokens` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
INSERT INTO `__new_usage_records` SELECT
  `id`, `run_id`, `session_id`, `model`, `date`,
  `input_tokens`, `output_tokens`, `reasoning_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `total_tokens`, `created_at`
FROM `usage_records`;
--> statement-breakpoint
DROP TABLE `usage_records`;
--> statement-breakpoint
ALTER TABLE `__new_usage_records` RENAME TO `usage_records`;
--> statement-breakpoint
CREATE INDEX `idx_usage_records_session` ON `usage_records` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_usage_records_date` ON `usage_records` (`date`);
--> statement-breakpoint
CREATE INDEX `idx_usage_records_model` ON `usage_records` (`model`);
