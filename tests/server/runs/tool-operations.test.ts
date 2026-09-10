import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase,
} from "../../../apps/server/src/db/index.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/modules/sessions/index.js";
import {
  DrizzleRunRepository,
  listToolExecutions,
  recordToolExecution,
} from "../../../apps/server/src/modules/runs/index.js";

describe("tool operation receipts", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    new DrizzleSessionRepository(db).create({ id: "session" });
    new DrizzleRunRepository(db).start({ id: "run", sessionId: "session" });
  });

  afterEach(() => closeDb(db));

  it("isolates identical provider call ids from main and child agents", () => {
    const main = recordToolExecution(db, "run", "main");
    const child = recordToolExecution(db, "run", "task-1");

    main({ type: "started", toolCallId: "call-1", toolName: "read_file", input: { path: "a" } });
    child({ type: "started", toolCallId: "call-1", toolName: "grep", input: { query: "a" } });
    main({ type: "completed", toolCallId: "call-1", output: "main output" });
    child({ type: "completed", toolCallId: "call-1", output: "child output" });

    expect(listToolExecutions(db, "run")).toEqual([
      expect.objectContaining({ agent: "main", toolName: "read_file", output: "main output" }),
      expect.objectContaining({ agent: "task-1", toolName: "grep", output: "child output" }),
    ]);
  });
});
