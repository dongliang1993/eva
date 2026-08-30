import { afterEach, describe, expect, it } from "vitest";

import { initDb, migrateDb, closeDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { BackgroundTaskRepository } from "../../../apps/server/src/db/repositories/background-task-repository.js";
import { SqliteTaskStore } from "../../../apps/server/src/services/subagents/sqlite-task-store.js";

let db: AppDatabase;
const make = () => new SqliteTaskStore(db, new BackgroundTaskRepository(db));

afterEach(async () => {
  if (db) closeDb(db as AppDatabase);
});

/** 每个用例独立内存库 —— 避免跨用例状态。 */
const freshDb = (): AppDatabase => {
  const d = initDb({ dbPath: ":memory:" });
  migrateDb(d);
  return d;
};

describe("SqliteTaskStore (S7 任务事实)", () => {
  it("create → running;settle(result) → done + result", async () => {
    db = freshDb();
    const store = make();
    await store.create({ id: "t1", sessionId: "s1", parentToolCallId: "ptc1", subagentType: "explorer", depth: 0 });

    expect((await store.get("t1"))?.status).toBe("running");
    await store.settle("t1", { result: "done studying" });
    const settled = await store.get("t1");
    expect(settled?.status).toBe("done");
    expect(settled?.result).toBe("done studying");
    expect(settled?.endedAt).not.toBeNull();
  });

  it("settle(error) → failed + error (坑2 子代理抛错)", async () => {
    db = freshDb();
    const store = make();
    await store.create({ id: "t2", sessionId: "s1", parentToolCallId: "ptc2", subagentType: "explorer", depth: 0 });
    await store.settle("t2", { error: "subagent threw" });
    const r = await store.get("t2");
    expect(r?.status).toBe("failed");
    expect(r?.error).toBe("subagent threw");
  });

  it("waitFor 已终态 → 立即返回,不挂", async () => {
    db = freshDb();
    const store = make();
    await store.create({ id: "t3", sessionId: "s1", parentToolCallId: "ptc", subagentType: "reviewer", depth: 0 });
    await store.settle("t3", { result: "ok" });
    const r = await store.waitFor("t3", 1000);
    expect(r?.status).toBe("done");
  });

  it("waitFor 运行中且之后 settle → settle 立即 resolve,不等超时", async () => {
    db = freshDb();
    const store = make();
    await store.create({ id: "t4", sessionId: "s", parentToolCallId: "ptc", subagentType: "explorer", depth: 0 });
    const pending = store.waitFor("t4", 5000);
    await store.settle("t4", { result: "finished" });
    const r = await pending;
    expect(r?.status).toBe("done");
  });

  it("waitFor 永不 settle → 超时返回 running 快照", async () => {
    db = freshDb();
    const store = make();
    await store.create({ id: "t5", sessionId: "s1", parentToolCallId: "ptc", subagentType: "explorer", depth: 0 });
    const r = await store.waitFor("t5", 50);
    expect(r?.status).toBe("running");
  });

  it("未知 taskId → waitFor/get 返回 undefined", async () => {
    db = freshDb();
    const store = make();
    expect(await store.get("nope")).toBeUndefined();
    expect(await store.waitFor("nope", 10)).toBeUndefined();
  });

  it("failStaleTasks:把进程重启遗留的 running 收成 failed", async () => {
    db = freshDb();
    const repo = new BackgroundTaskRepository(db);
    await repo.create({ id: "t-stale", sessionId: "s", parentToolCallId: "ptc", subagentType: "explorer", depth: 0 });
    // settle 一条做对照(不该被碰)。
    repo.create({ id: "t-fine", sessionId: "s", parentToolCallId: "ptc", subagentType: "explorer", depth: 0 });
    repo.settle("t-fine", { result: "ok" });

    const { failStaleTasks } = await import("../../../apps/server/src/db/repositories/background-task-repository.js");
    expect(failStaleTasks(db)).toBe(1);
    expect(repo.findById("t-stale")?.status).toBe("failed");
    expect(repo.findById("t-fine")?.status).toBe("done");
  });
});
