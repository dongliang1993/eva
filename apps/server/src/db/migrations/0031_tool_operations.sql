CREATE TABLE tool_operations (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (run_id, agent, tool_call_id)
);
--> statement-breakpoint
DROP TABLE session_skill_selections;
--> statement-breakpoint
ALTER TABLE background_tasks RENAME TO subagent_tasks;
--> statement-breakpoint
DROP INDEX idx_background_tasks_session;
--> statement-breakpoint
CREATE INDEX idx_subagent_tasks_session ON subagent_tasks(session_id);
--> statement-breakpoint
DROP INDEX idx_runs_parent_run_id;
--> statement-breakpoint
DROP INDEX idx_runs_background_task_id;
--> statement-breakpoint
ALTER TABLE runs DROP COLUMN parent_run_id;
--> statement-breakpoint
ALTER TABLE runs DROP COLUMN background_task_id;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_runs_active_session ON runs(session_id)
WHERE status = 'running';
--> statement-breakpoint
DROP INDEX idx_memories_embedding_status;
--> statement-breakpoint
ALTER TABLE memories DROP COLUMN embedding_status;
--> statement-breakpoint
ALTER TABLE memories DROP COLUMN embedding_model;
--> statement-breakpoint
ALTER TABLE memories DROP COLUMN embedded_at;
--> statement-breakpoint
ALTER TABLE memories DROP COLUMN last_recalled_at;
