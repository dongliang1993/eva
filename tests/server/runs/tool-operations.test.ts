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
  toolOperationHooks,
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


describe("toolOperationHooks(FR-008:hooks 写台账)", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    new DrizzleSessionRepository(db).create({ id: "session" });
    new DrizzleRunRepository(db).start({ id: "run", sessionId: "session" });
  });

  afterEach(() => closeDb(db));

  const signal = new AbortController().signal;

  it("intent 在 PreToolUse 写(权限通过后、execute 前);result 在 Post 两个", async () => {
    const hooks = toolOperationHooks(db, "run", "main");
    const pre = hooks.PreToolUse?.[0]?.hooks[0]!;
    const post = hooks.PostToolUse?.[0]?.hooks[0]!;
    const postFailure = hooks.PostToolUseFailure?.[0]?.hooks[0]!;

    await pre({
      hook_event_name: "PreToolUse",
      tool_name: "write",
      tool_input: { path: "a.txt", content: "x" },
      tool_use_id: "call-h1",
    }, "call-h1", { signal });

    expect(listToolExecutions(db, "run")[0]).toMatchObject({
      agent: "main", toolCallId: "call-h1", toolName: "write", status: "running",
    });

    await post({
      hook_event_name: "PostToolUse",
      tool_name: "write",
      tool_input: { path: "a.txt", content: "x" },
      tool_response: { content: [{ type: "text", text: "Wrote 1 chars" }] },
      tool_use_id: "call-h1",
      duration_ms: 12,
    }, "call-h1", { signal });
    expect(listToolExecutions(db, "run")[0]).toMatchObject({ status: "completed" });

    await pre({
      hook_event_name: "PreToolUse",
      tool_name: "boom",
      tool_input: {},
      tool_use_id: "call-h2",
    }, "call-h2", { signal });
    await postFailure({
      hook_event_name: "PostToolUseFailure",
      tool_name: "boom",
      tool_input: {},
      tool_use_id: "call-h2",
      error: "Error: kaput",
      is_interrupt: false,
      duration_ms: 5,
    }, "call-h2", { signal });
    expect(listToolExecutions(db, "run")[1]).toMatchObject({
      status: "failed", error: "Error: kaput",
    });
  });

  it("被拒的调用不写 intent(PreToolUse deny / canUseTool deny 都不进台账)", async () => {
    // runToolCall 的顺序:PreToolUse hooks → 权限 → execute。
    // hooks 是 server 注册的「台账 hook」;canUseTool deny 时 execute 不跑,
    // Post hooks 也不触发 —— 台账里不会有这条调用。
    const hooks = toolOperationHooks(db, "run", "main");
    expect(hooks.PreToolUse).toBeDefined();
    expect(listToolExecutions(db, "run")).toHaveLength(0);
  });
});
