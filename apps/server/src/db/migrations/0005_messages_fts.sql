-- Add search_text and metadata columns to messages
ALTER TABLE `messages` ADD COLUMN `search_text` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `messages` ADD COLUMN `metadata` text NOT NULL DEFAULT '{}';
--> statement-breakpoint
-- Create FTS5 virtual table for full-text search on messages
CREATE VIRTUAL TABLE IF NOT EXISTS `messages_fts` USING fts5(
  message_id UNINDEXED,
  session_id UNINDEXED,
  content
);
--> statement-breakpoint
-- Trigger: insert into FTS when a message is inserted with non-empty search_text
CREATE TRIGGER IF NOT EXISTS messages_fts_insert
AFTER INSERT ON `messages`
WHEN NEW.search_text != ''
BEGIN
  INSERT INTO messages_fts(message_id, session_id, content)
  VALUES (NEW.id, NEW.session_id, NEW.search_text);
END;
--> statement-breakpoint
-- Trigger: update FTS when search_text changes
CREATE TRIGGER IF NOT EXISTS messages_fts_update
AFTER UPDATE OF search_text ON `messages`
WHEN NEW.search_text != OLD.search_text
BEGIN
  DELETE FROM messages_fts WHERE message_id = OLD.id;
  INSERT INTO messages_fts(message_id, session_id, content)
  SELECT NEW.id, NEW.session_id, NEW.search_text
  WHERE NEW.search_text != '';
END;
--> statement-breakpoint
-- Trigger: delete from FTS when a message is deleted
CREATE TRIGGER IF NOT EXISTS messages_fts_delete
AFTER DELETE ON `messages`
BEGIN
  DELETE FROM messages_fts WHERE message_id = OLD.id;
END;
--> statement-breakpoint
-- Backfill: populate search_text from content for user messages (plain text)
UPDATE `messages` SET search_text = content WHERE role = 'user' AND search_text = '';
--> statement-breakpoint
-- Backfill: populate FTS index from existing messages with non-empty search_text
INSERT INTO messages_fts(message_id, session_id, content)
SELECT id, session_id, search_text FROM `messages` WHERE search_text != '';
