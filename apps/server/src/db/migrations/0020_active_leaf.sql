ALTER TABLE `sessions` ADD COLUMN `active_leaf_id` text;
--> statement-breakpoint
-- 回填:老会话的激活叶子 = 时间上最后一条消息。回填后行为与升级前完全一致。
UPDATE `sessions` SET `active_leaf_id` = (
  SELECT `id` FROM `messages`
  WHERE `messages`.`session_id` = `sessions`.`id`
  ORDER BY `created_at` DESC, `rowid` DESC
  LIMIT 1
);