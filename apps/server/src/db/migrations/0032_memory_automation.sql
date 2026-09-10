ALTER TABLE memories ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'global';
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN memory_key TEXT;
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN source_run_id TEXT;
--> statement-breakpoint
ALTER TABLE memories ADD COLUMN confidence INTEGER;
--> statement-breakpoint
CREATE INDEX idx_memories_scope_status ON memories(user_id, scope_key, status);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_memories_active_key ON memories(user_id, scope_key, memory_key)
WHERE memory_key IS NOT NULL AND status = 'active';
--> statement-breakpoint
CREATE VIRTUAL TABLE memories_fts USING fts5(
  memory_id UNINDEXED,
  user_id UNINDEXED,
  scope_key UNINDEXED,
  status UNINDEXED,
  content,
  tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(memory_id, user_id, scope_key, status, content)
  VALUES (new.id, new.user_id, new.scope_key, new.status, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
  INSERT INTO memories_fts(memory_id, user_id, scope_key, status, content)
  VALUES (new.id, new.user_id, new.scope_key, new.status, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE memory_id = old.id;
END;
--> statement-breakpoint
INSERT INTO memories_fts(memory_id, user_id, scope_key, status, content)
SELECT id, user_id, scope_key, status, content FROM memories;
--> statement-breakpoint
CREATE TABLE run_memory_refs (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  score INTEGER NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'fts',
  injected_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, memory_id)
);
--> statement-breakpoint
CREATE INDEX idx_run_memory_refs_memory ON run_memory_refs(memory_id);
--> statement-breakpoint
CREATE TABLE memory_extraction_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  source_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  workspace_id TEXT,
  source_user_message_id TEXT NOT NULL,
  source_assistant_message_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  usage TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  ended_at TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_memory_extraction_jobs_run ON memory_extraction_jobs(source_run_id);
--> statement-breakpoint
CREATE INDEX idx_memory_extraction_jobs_status ON memory_extraction_jobs(status, created_at);
--> statement-breakpoint
CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES memory_extraction_jobs(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_memory_id TEXT,
  category TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  evidence_message_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
--> statement-breakpoint
CREATE INDEX idx_memory_candidates_status ON memory_candidates(status, created_at);
--> statement-breakpoint
CREATE INDEX idx_memory_candidates_job ON memory_candidates(job_id);
