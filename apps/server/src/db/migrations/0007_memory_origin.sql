-- Add origin column to memories for tracking how the memory was created
ALTER TABLE `memories` ADD COLUMN `origin` text NOT NULL DEFAULT 'manual';
