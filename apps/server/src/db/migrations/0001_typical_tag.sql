CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`icon` text DEFAULT '' NOT NULL,
	`enabled` text DEFAULT 'false' NOT NULL,
	`api_key` text DEFAULT '' NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`base_url_placeholder` text DEFAULT '' NOT NULL,
	`base_url_hint` text DEFAULT '' NOT NULL,
	`api_key_hint` text DEFAULT '' NOT NULL,
	`models` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
