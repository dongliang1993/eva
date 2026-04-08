-- Non-destructive session compaction snapshots
CREATE TABLE `session_compactions` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `summary` text NOT NULL,
  `covered_until_message_id` text NOT NULL,
  `covered_message_count` integer NOT NULL,
  `preserved_tail_message_count` integer NOT NULL,
  `estimated_tokens_before` integer,
  `estimated_tokens_after` integer,
  `trigger` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_session_compactions_session_id` ON `session_compactions` (`session_id`);
