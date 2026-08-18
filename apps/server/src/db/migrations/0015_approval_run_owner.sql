-- 审批归属从 session 收敛到 run(docs 14 §5.1「审批挂在 run 边界上」)。
-- session_id 保留:前端按会话渲染待审批列表,查询仍走它。
ALTER TABLE `approval_requests` ADD COLUMN `run_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_approval_requests_run` ON `approval_requests` (`run_id`);