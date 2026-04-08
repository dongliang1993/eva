-- Provider models cache: stores fetched model lists per provider
CREATE TABLE `provider_models_cache` (
  `id` text PRIMARY KEY NOT NULL,
  `provider_id` text NOT NULL,
  `models` text NOT NULL DEFAULT '[]',
  `fetched_at` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pmc_provider_id` ON `provider_models_cache` (`provider_id`);
--> statement-breakpoint
-- Model capabilities cache: stores per-model capability metadata
CREATE TABLE `model_capabilities_cache` (
  `id` text PRIMARY KEY NOT NULL,
  `model_id` text NOT NULL,
  `capabilities` text NOT NULL DEFAULT '{}',
  `fetched_at` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mcc_model_id` ON `model_capabilities_cache` (`model_id`);
