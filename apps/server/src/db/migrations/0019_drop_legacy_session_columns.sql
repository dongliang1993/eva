-- T10: 删 sessions 表死列与 session_key(docs 15 S16 需要时重建,见 r1/FINDINGS)。
-- DROP COLUMN 前必须先删依赖它的索引,否则 SQLite 报错。
DROP INDEX IF EXISTS `idx_sessions_session_key`;
--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `session_key`;
--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `reasoning_effort`;
--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `tool_policy`;
--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `skill_policy`;
--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `memory_policy`;
--> statement-breakpoint
-- 两张从未被读过的缓存表(T7 已把 provider-models.ts 内容并走,这两张表零读写)。
DROP TABLE IF EXISTS `provider_models_cache`;
--> statement-breakpoint
DROP TABLE IF EXISTS `model_capabilities_cache`;