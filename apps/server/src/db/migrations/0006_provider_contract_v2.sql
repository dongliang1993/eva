CREATE TABLE `__new_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'custom' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`icon` text DEFAULT '' NOT NULL,
	`enabled` text DEFAULT 'false' NOT NULL,
	`api_key` text DEFAULT '' NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`base_url_placeholder` text DEFAULT '' NOT NULL,
	`base_url_hint` text DEFAULT '' NOT NULL,
	`api_key_hint` text DEFAULT '' NOT NULL,
	`models` text DEFAULT '[]' NOT NULL,
	`available_models` text DEFAULT '[]' NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);--> statement-breakpoint

INSERT INTO `__new_providers` (
	`id`,
	`name`,
	`type`,
	`description`,
	`icon`,
	`enabled`,
	`api_key`,
	`base_url`,
	`base_url_placeholder`,
	`base_url_hint`,
	`api_key_hint`,
	`models`,
	`available_models`,
	`updated_at`,
	`created_at`
)
SELECT
	`id`,
	`name`,
	CASE `id`
		WHEN 'openai' THEN 'openai'
		WHEN 'anthropic' THEN 'anthropic'
		WHEN 'google' THEN 'google'
		WHEN 'aihubmix' THEN 'aihubmix'
		WHEN 'openrouter' THEN 'openrouter'
		WHEN 'deepseek' THEN 'deepseek'
		WHEN 'copilot' THEN 'copilot'
		WHEN 'azure' THEN 'azure'
		WHEN 'moonshot' THEN 'moonshot'
		ELSE 'custom'
	END,
	`description`,
	`icon`,
	`enabled`,
	`api_key`,
	`base_url`,
	`base_url_placeholder`,
	`base_url_hint`,
	`api_key_hint`,
	`models`,
	`models`,
	`created_at`,
	`created_at`
FROM `providers`;--> statement-breakpoint

DROP TABLE `providers`;--> statement-breakpoint
ALTER TABLE `__new_providers` RENAME TO `providers`;
