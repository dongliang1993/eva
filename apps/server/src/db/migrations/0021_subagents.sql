-- 子代理消息与主链隔离(docs 14 §7 S7)。
-- 子代理进程里的 message 也进 messages 表,但挂 parent_tool_call_id,
-- 主链构建时按 parent_tool_call_id IS NULL 过滤,否则子代理的过程消息会污染主上下文。
ALTER TABLE `messages` ADD COLUMN `parent_tool_call_id` text;
--> statement-breakpoint
CREATE INDEX `idx_messages_parent_tool_call` ON `messages` (`parent_tool_call_id`);
--> statement-breakpoint
-- 后台子代理任务的事实表(transcript 在 messages 表,不存第二份)。
CREATE TABLE `background_tasks` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `parent_tool_call_id` text NOT NULL,
  `subagent_type` text NOT NULL,
  `depth` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'running',
  `result` text,
  `error` text,
  `started_at` text NOT NULL,
  `ended_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_background_tasks_session` ON `background_tasks` (`session_id`);
