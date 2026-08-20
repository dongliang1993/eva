-- T21:token 用量独立表。runs.usage JSON 里 SQL 进不去(按天/按模型聚合、
-- cache 命中成本核算全都做不到),照 Alma docs 04 §8.7.1 裁剪落地:
-- 砍 cache_write_input_tokens(SDK 不暴露);run_id 取代 message_id(usage 天然归属 run)。
-- 历史 runs.usage 不回填 —— 本地单机库,历史用量没有决策价值。
CREATE TABLE `usage_records` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL REFERENCES `runs`(`id`) ON DELETE CASCADE,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `model` text,
  `date` text NOT NULL,
  `input_tokens` integer NOT NULL DEFAULT 0,
  `output_tokens` integer NOT NULL DEFAULT 0,
  `reasoning_tokens` integer NOT NULL DEFAULT 0,
  `cached_input_tokens` integer NOT NULL DEFAULT 0,
  `total_tokens` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_usage_records_session` ON `usage_records` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_usage_records_date` ON `usage_records` (`date`);
--> statement-breakpoint
CREATE INDEX `idx_usage_records_model` ON `usage_records` (`model`);
