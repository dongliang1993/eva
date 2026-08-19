import { describe, it, expect } from "vitest";
import { initDb, migrateDb, closeDb, type AppDatabase } from "../apps/server/src/db/index.js";

describe("migration 0021 subagents", () => {
  it("applies cleanly on a fresh DB", () => {
    const db = initDb({ dbPath: ":memory:" });
    migrateDb(db as AppDatabase);
    // prove schema via $client
    const sqlite = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
    const cols = sqlite.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
    expect(cols).toContain("parent_tool_call_id");
    const bt = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='background_tasks'").all();
    expect(bt.length).toBe(1);

    // 0022:description(卡片标题与通知文本都要它)。
    const btCols = sqlite.prepare("PRAGMA table_info(background_tasks)").all().map(c => c.name);
    expect(btCols).toContain("description");

    closeDb(db as AppDatabase);
  });
});
