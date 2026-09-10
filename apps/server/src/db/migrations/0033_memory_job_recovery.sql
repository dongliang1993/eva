ALTER TABLE memories ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE memory_extraction_jobs ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE memory_candidates ADD COLUMN target_revision INTEGER;
