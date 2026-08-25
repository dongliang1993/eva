-- T44:skill auto-selection 的 thread 累积集。LLM 选中不可重放,落选表;
-- always-inject 不落表(仍从 frontmatter 现算)。origin='forced' 是渠道强制规则预留(Eva 首版无)。
CREATE TABLE `session_skill_selections` (
  `session_id` text NOT NULL,
  `skill_name` text NOT NULL,
  `origin` text NOT NULL DEFAULT 'auto',
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(`session_id`, `skill_name`),
  FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_skill_selections_session` ON `session_skill_selections` (`session_id`);
