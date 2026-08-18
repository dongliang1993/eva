-- 未知 provider type 归一成 custom(它们从未被 agent runtime 支持过)
UPDATE `providers`
SET `type` = 'custom'
WHERE `type` NOT IN ('openai','anthropic','deepseek','openrouter','moonshot','aihubmix','custom');
--> statement-breakpoint
-- enabled: text("true"/"false") → integer(0/1)
ALTER TABLE `providers` ADD COLUMN `enabled_flag` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `providers` SET `enabled_flag` = CASE WHEN `enabled` IN ('true','1') THEN 1 ELSE 0 END;
--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `enabled`;
--> statement-breakpoint
ALTER TABLE `providers` RENAME COLUMN `enabled_flag` TO `enabled`;
--> statement-breakpoint
-- UI 文案回归 provider-catalog.ts,不再逐行拷贝
ALTER TABLE `providers` DROP COLUMN `description`;
--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `icon`;
--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `base_url_placeholder`;
--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `base_url_hint`;
--> statement-breakpoint
ALTER TABLE `providers` DROP COLUMN `api_key_hint`;