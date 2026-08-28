-- T47:append-only 执行事实 ledger(S27)。start/completed 配对,不 UPDATE 旧行;
-- 崩溃收口靠启动清扫追加 abandoned 事件。时间一律 epoch ms,与 runs/messages 的
-- ISO text 只做 run_id 关联,不做跨表时间运算。
-- seq 由 Run 级 recorder 独占单调分配(同一 Run 主 Agent 与前台子代理共用一个
-- recorder),UNIQUE(run_id, seq) 靠这个纪律成立。
CREATE TABLE `run_events` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `session_id` text NOT NULL,
  `seq` integer NOT NULL,
  `agent` text NOT NULL,
  `kind` text NOT NULL,
  `turn_index` integer,
  `step_index` integer,
  `attempt` integer,
  `tool_call_id` text,
  `parent_tool_call_id` text,
  `severity` text NOT NULL DEFAULT 'info',
  `payload` text NOT NULL,
  `occurred_at_ms` integer NOT NULL,
  `duration_ms` integer,
  FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_run_events_run_seq` ON `run_events` (`run_id`, `seq`);
--> statement-breakpoint
CREATE INDEX `idx_run_events_run_tool_call` ON `run_events` (`run_id`, `tool_call_id`);
--> statement-breakpoint
CREATE INDEX `idx_run_events_run_time` ON `run_events` (`run_id`, `occurred_at_ms`);
--> statement-breakpoint
CREATE INDEX `idx_run_events_session_time` ON `run_events` (`session_id`, `occurred_at_ms`, `run_id`, `seq`);
