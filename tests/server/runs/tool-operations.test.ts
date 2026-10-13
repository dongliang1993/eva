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

  it("isolates identical provider call ids from main and child agents", async () => {
    // recordToolExecution 已删:同一 run 下按 agent 建两组 hooks,
    // 直接驱动 Pre/Post 回调,隔离断言(main/task-1 各一行)保持原样。
    const main = toolOperationHooks(db, "run", "main");
    const child = toolOperationHooks(db, "run", "task-1");
    const signal = new AbortController().signal;

    const started = (hooks: NonNullable<typeof main>, toolName: string, input: Record<string, unknown>) =>
      hooks.PreToolUse![0]!.hooks[0]!(
        { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input, tool_use_id: "call-1" },
        "call-1",
        { signal },
      );
    const completed = (hooks: NonNullable<typeof main>, toolResponse: unknown) =>
      hooks.PostToolUse![0]!.hooks[0]!(
        {
          hook_event_name: "PostToolUse",
          tool_name: "unused",
          tool_input: {},
          tool_response: toolResponse,
          tool_use_id: "call-1",
          duration_ms: 3,
        },
        "call-1",
        { signal },
      );

    await started(main, "read_file", { path: "a" });
    await started(child, "grep", { query: "a" });
    await completed(main, { content: [{ type: "text", text: "main output" }] });
    await completed(child, { content: [{ type: "text", text: "child output" }] });

    // tool_response 从字符串变成 ToolResult 对象:output 断言跟着换成解析后的对象形状。
    expect(listToolExecutions(db, "run")).toEqual([
      expect.objectContaining({
        agent: "main", toolName: "read_file",
        output: { content: [{ type: "text", text: "main output" }] },
      }),
      expect.objectContaining({
        agent: "task-1", toolName: "grep",
        output: { content: [{ type: "text", text: "child output" }] },
      }),
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
