import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../apps/server/node_modules/fastify";

import { closeDb, initDb, migrateDb, type AppDatabase } from "../apps/server/src/db/index.js";
import { backgroundTasks, runs, sessions } from "../apps/server/src/db/schema.js";
import { RunEventRepository } from "../apps/server/src/db/repositories/run-event-repository.js";
import { registerLoopbackTokenHook } from "../apps/server/src/loopback.js";
import { registerTrajectoryRoutes } from "../apps/server/src/routes/trajectory.js";
import type {
  RunEventDto,
  RunTrajectoryResponse,
  SessionTrajectoryResponse
} from "@eva/shared";

describe("trajectory API(T52)", () => {
  let app: FastifyInstance;
  let db: AppDatabase;

  beforeEach(async () => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    app = Fastify();
    app.decorate("infra", { db });
    registerTrajectoryRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDb(db);
  });

  const seedRun = (
    runId: string,
    sessionId: string,
    options: { parentRunId?: string; backgroundTaskId?: string } = {}
  ): void => {
    db.insert(sessions).values({ id: sessionId }).onConflictDoNothing().run();
    db.insert(runs)
      .values({
        id: runId,
        sessionId,
        ...(options.parentRunId !== undefined ? { parentRunId: options.parentRunId } : {}),
        ...(options.backgroundTaskId !== undefined
          ? { backgroundTaskId: options.backgroundTaskId }
          : {})
      })
      .run();
  };

  const seedEvents = (
    runId: string,
    sessionId: string,
    count: number,
    startMs: number,
    msStep = 1
  ): void => {
    const repo = new RunEventRepository(db);
    for (let i = 0; i < count; i += 1) {
      repo.append({
        id: `${runId}-e-${i}`,
        runId,
        sessionId,
        seq: i,
        agent: "main",
        kind: "step_started",
        payload: "{}",
        occurredAtMs: startMs + i * msStep
      });
    }
  };

  it("三条主 Run 各 120 条:三元组游标翻页取完 360 条,无重复无丢失", async () => {
    seedRun("run-a", "s-1");
    seedRun("run-b", "s-1");
    seedRun("run-c", "s-1");
    // 三条 Run 的 seq 都从 0 开始(区间重叠),occurredAtMs 交错
    seedEvents("run-a", "s-1", 120, 1000);
    seedEvents("run-b", "s-1", 120, 1050);
    seedEvents("run-c", "s-1", 120, 1100);

    const collected: RunEventDto[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const url = `/api/v1/threads/s-1/trajectory?limit=50${cursor ?? ""}`;
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      const body = response.json() as SessionTrajectoryResponse;
      collected.push(...body.events);
      if (body.nextCursor === null) break;
      cursor = `&beforeOccurredAtMs=${body.nextCursor.beforeOccurredAtMs}&beforeRunId=${body.nextCursor.beforeRunId}&beforeSeq=${body.nextCursor.beforeSeq}`;
    }

    expect(collected).toHaveLength(360);
    expect(new Set(collected.map((e) => e.id)).size).toBe(360);
    // 与三元组倒序完全一致
    const sorted = [...collected].sort((a, b) =>
      b.occurredAtMs - a.occurredAtMs
      || b.runId.localeCompare(a.runId)
      || b.seq - a.seq
    );
    expect(collected.map((e) => e.id)).toEqual(sorted.map((e) => e.id));
    // seq 重叠的三条 Run 没串:每条 run 的事件齐全
    for (const runId of ["run-a", "run-b", "run-c"]) {
      expect(collected.filter((e) => e.runId === runId)).toHaveLength(120);
    }
  });

  it("同一毫秒跨 Run 的事件:翻页边界不重复也不跳过", async () => {
    seedRun("run-a", "s-1");
    seedRun("run-b", "s-1");
    seedEvents("run-a", "s-1", 10, 1000, 0); // 全部同一毫秒
    seedEvents("run-b", "s-1", 10, 1000, 0);

    const collected: RunEventDto[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url = `/api/v1/threads/s-1/trajectory?limit=7${cursor ?? ""}`;
      const response = await app.inject({ method: "GET", url });
      const body = response.json() as SessionTrajectoryResponse;
      collected.push(...body.events);
      if (body.nextCursor === null) break;
      cursor = `&beforeOccurredAtMs=${body.nextCursor.beforeOccurredAtMs}&beforeRunId=${body.nextCursor.beforeRunId}&beforeSeq=${body.nextCursor.beforeSeq}`;
    }

    expect(collected).toHaveLength(20);
    expect(new Set(collected.map((e) => e.id)).size).toBe(20);
  });

  it("subRuns 不受 before* 影响;后台子 Run 事件不进 events,单 Run 接口可拉", async () => {
    seedRun("parent", "s-1");
    db.insert(backgroundTasks)
      .values({
        id: "task-1",
        sessionId: "s-1",
        parentToolCallId: "call-1",
        subagentType: "explorer"
      })
      .run();
    seedRun("child", "s-1", { parentRunId: "parent", backgroundTaskId: "task-1" });
    seedEvents("parent", "s-1", 5, 1000);
    seedEvents("child", "s-1", 7, 2000);

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/threads/s-1/trajectory?limit=2"
    });
    const body1 = first.json() as SessionTrajectoryResponse;
    expect(body1.events).toHaveLength(2);
    expect(body1.events.every((e) => e.runId === "parent")).toBe(true);
    expect(body1.subRuns).toHaveLength(1);
    expect(body1.subRuns[0]).toMatchObject({
      runId: "child",
      parentRunId: "parent",
      backgroundTaskId: "task-1",
      subagentType: "explorer",
      parentToolCallId: "call-1",
      eventCount: 7
    });

    // 带 before* 再查:subRuns 内容不变
    const second = await app.inject({
      method: "GET",
      url: `/api/v1/threads/s-1/trajectory?limit=2&beforeOccurredAtMs=${body1.nextCursor?.beforeOccurredAtMs}&beforeRunId=${body1.nextCursor?.beforeRunId}&beforeSeq=${body1.nextCursor?.beforeSeq}`
    });
    const body2 = second.json() as SessionTrajectoryResponse;
    expect(body2.subRuns).toEqual(body1.subRuns);

    // 单 Run 接口拉子 Run 的全部事件
    const childResponse = await app.inject({
      method: "GET",
      url: "/api/v1/runs/child/trajectory?limit=50"
    });
    const childBody = childResponse.json() as RunTrajectoryResponse;
    expect(childBody.events).toHaveLength(7);
    expect(childBody.events.every((e) => e.runId === "child")).toBe(true);
  });

  it("单 Run 接口:beforeSeq 翻页正确;传 beforeOccurredAtMs 直接 400", async () => {
    seedRun("run-a", "s-1");
    seedEvents("run-a", "s-1", 25, 1000);

    const page1 = await app.inject({ method: "GET", url: "/api/v1/runs/run-a/trajectory?limit=10" });
    const body1 = page1.json() as RunTrajectoryResponse;
    expect(body1.events.map((e) => e.seq)).toEqual([24, 23, 22, 21, 20, 19, 18, 17, 16, 15]);
    expect(body1.nextBeforeSeq).toBe(15);

    const page2 = await app.inject({
      method: "GET",
      url: `/api/v1/runs/run-a/trajectory?limit=10&beforeSeq=${body1.nextBeforeSeq}`
    });
    const body2 = page2.json() as RunTrajectoryResponse;
    expect(body2.events.map((e) => e.seq)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);

    const bad = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-a/trajectory?beforeOccurredAtMs=1000"
    });
    expect(bad.statusCode).toBe(400);
  });

  it("session-log:行数 = 总事件 + 1,三元组稳定排序,两次导出 byte 相同", async () => {
    seedRun("parent", "s-1");
    seedRun("child", "s-1", { parentRunId: "parent" });
    seedEvents("parent", "s-1", 30, 1000);
    seedEvents("child", "s-1", 20, 1500); // 子 Run 也包含在导出里

    const url = "/api/v1/threads/s-1/session-log";
    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url }),
      app.inject({ method: "GET", url })
    ]);
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("application/x-ndjson");
    expect(first.headers["content-disposition"]).toContain("session-s-1.jsonl");
    expect(second.body).toBe(first.body);

    const lines = first.body.trim().split("\n");
    expect(lines).toHaveLength(50 + 1);
    const header = JSON.parse(lines[0]!) as { type: string; sessionId: string; createdAt: number };
    expect(header.type).toBe("session");
    expect(header.sessionId).toBe("s-1");
    expect(header.version ?? 1).toBe(1);
    // 会话创建时间:落库事实,不是导出时间(两次导出 byte 相同已在上断言)
    expect(typeof header.createdAt).toBe("number");

    const events = lines.slice(1).map((line) => JSON.parse(line) as {
      run_id: string; seq: number; occurred_at_ms: number;
      data: { agent: string; kind: string; payload: unknown };
    });
    // 信封 = 身份与排序键;其余收进 data(对齐 DSH {type, seq, time, data} 形状)
    const firstEvent = JSON.parse(lines[1]!);
    expect(Object.keys(firstEvent)).toEqual(["type", "run_id", "seq", "occurred_at_ms", "data"]);
    expect(firstEvent.data.kind).toBe("step_started");
    expect(firstEvent.data.agent).toBe("main");

    // 升序三元组
    const sorted = [...events].sort((a, b) =>
      a.occurred_at_ms - b.occurred_at_ms
      || a.run_id.localeCompare(b.run_id)
      || a.seq - b.seq
    );
    expect(events).toEqual(sorted);
    // 每条都带 run_id + seq;不声称全会话 seq 连续(两条 Run 的 seq 都从 0 起)
    expect(events.filter((e) => e.run_id === "child")).toHaveLength(20);
    expect(events.filter((e) => e.run_id === "parent")).toHaveLength(30);
  });

  it("session/run 不存在 → 404", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/v1/threads/nope/trajectory" });
    expect(missing.statusCode).toBe(404);
    const missingRun = await app.inject({ method: "GET", url: "/api/v1/runs/nope/trajectory" });
    expect(missingRun.statusCode).toBe(404);
    const missingLog = await app.inject({ method: "GET", url: "/api/v1/threads/nope/session-log" });
    expect(missingLog.statusCode).toBe(404);
  });

  it("启用 loopback token:无 token 访问三个接口全部 401;GET /api/v1/threads 仍放行", async () => {
    const guarded = Fastify();
    guarded.decorate("infra", { db });
    registerLoopbackTokenHook(guarded, "test-token");
    registerTrajectoryRoutes(guarded);
    // 白名单豁免的路径给个 stub,验证它不被拦
    guarded.get("/api/v1/threads", async () => []);
    await guarded.ready();

    seedRun("run-a", "s-1");
    seedEvents("run-a", "s-1", 3, 1000);

    for (const url of [
      "/api/v1/threads/s-1/trajectory",
      "/api/v1/threads/s-1/session-log",
      "/api/v1/runs/run-a/trajectory"
    ]) {
      const denied = await guarded.inject({ method: "GET", url });
      expect(denied.statusCode, url).toBe(401);
      const allowed = await guarded.inject({
        method: "GET",
        url,
        headers: { "x-eva-token": "test-token" }
      });
      expect(allowed.statusCode, url).toBe(200);
    }

    const open = await guarded.inject({ method: "GET", url: "/api/v1/threads" });
    expect(open.statusCode).toBe(200);

    await guarded.close();
  });
});
