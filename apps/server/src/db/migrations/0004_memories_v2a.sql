-- Add category and metadata columns
ALTER TABLE `memories` ADD COLUMN `category` text NOT NULL DEFAULT 'knowledge';
--> statement-breakpoint
ALTER TABLE `memories` ADD COLUMN `metadata` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
-- Rename source columns
ALTER TABLE `memories` RENAME COLUMN `thread_id` TO `source_session_id`;
--> statement-breakpoint
ALTER TABLE `memories` RENAME COLUMN `message_id` TO `source_message_id`;
--> statement-breakpoint
-- Add category index
CREATE INDEX `idx_memories_category` ON `memories` (`category`);
