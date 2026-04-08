-- Add embedding lifecycle columns to memories
ALTER TABLE `memories` ADD COLUMN `embedding_status` text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `embedding_model` text;
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `embedded_at` text;
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `last_recalled_at` text;
--> statement-breakpoint
CREATE INDEX `idx_memories_embedding_status` ON `memories` (`embedding_status`);
