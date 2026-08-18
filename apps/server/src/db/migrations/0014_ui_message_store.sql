-- messages: 自造的 content blocks → UIMessage 整存
ALTER TABLE `messages` ADD COLUMN `message` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `run_id` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `parent_id` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `slot_id` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `depth` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 回填:旧行统一降级成单个 text part。
-- assistant 的旧 content 可能是 content-blocks JSON,它的纯文本投影已经在
-- search_text 里(0005 之后写入的都有),用它;user 行直接用 content。
-- 工具轨迹不做还原:旧数据里 tool_use 的入参已经被历史构建丢弃过一轮,
-- 还原出来也不是模型当时看到的东西。
UPDATE `messages`
SET `message` = json_object(
  'id', `id`,
  'role', `role`,
  'parts', json_array(json_object(
    'type', 'text',
    'state', 'done',
    'text', CASE
      WHEN `role` = 'assistant'
        AND json_valid(`content`)
        AND json_type(`content`) = 'array'
      THEN `search_text`
      ELSE `content`
    END
  ))
)
WHERE `message` = '';
--> statement-breakpoint
-- 旧列退场:三列的信息已经并入 message JSON。
-- token_usage 从未被写过(唯一写入点在测试里),metadata 只被 threads 路由
-- 原样回吐给前端、前端从不读。
ALTER TABLE `messages` DROP COLUMN `content`;
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `metadata`;
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `token_usage`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_run_id` ON `messages` (`run_id`);
--> statement-breakpoint
-- runs: 一次执行一行(docs 14 §5.1「Run 提为一等概念」)
CREATE TABLE IF NOT EXISTS `runs` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE cascade,
  `status` text DEFAULT 'running' NOT NULL,
  `model` text,
  `user_message_id` text,
  `assistant_message_id` text,
  `finish_reason` text,
  `usage` text,
  `error` text,
  `started_at` text DEFAULT (datetime('now')) NOT NULL,
  `ended_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_session_id` ON `runs` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_status` ON `runs` (`status`);