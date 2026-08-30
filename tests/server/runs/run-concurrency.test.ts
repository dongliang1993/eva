import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";

import { createAgent, type Agent } from "../../../packages/harness/src/index.js";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { loadConfig } from "../../../apps/server/src/config.js";
import { closeDb, initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { ApprovalRepository } from "../../../apps/server/src/db/repositories/approval-repository.js";
import { DrizzleMessageRepository } from "../../../apps/server/src/db/repositories/message-repository.js";
import { DrizzleRunRepository } from "../../../apps/server/src/db/repositories/run-repository.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/db/repositories/session-repository.js";
import { ApprovalGateway } from "../../../apps/server/src/services/approval-gateway.js";
import { RunLedger } from "../../../apps/server/src/services/runs/run-ledger.js";
import { RunRegistry } from "../../../apps/server/src/services/run-registry.js";
import { SessionService } from "../../../apps/server/src/services/session.js";
import { registerRunRoutes } from "../../../apps/server/src/routes/runs.js";
import { decorateAppApi } from "../../helpers/app-api.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

const textAgent = (): Agent =>
  createAgent({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "ok" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: "stop", usage }
          ]
        })
      })
    }),
    tools: [],
    maxSteps: 3
  });

const rawClient = (db: AppDatabase): import("better-sqlite3").Database =>
  (db as unknown as { $client: import("better-sqlite3").Database }).$client;

let app: FastifyInstance;
let db: AppDatabase;

const startApp = async (): Promise<void> => {
  const agent = textAgent();
  app = Fastify();
  app.decorate("infra", { config: loadConfig({ env: {}, cwd: "/tmp" }), db, skills: [] });
  app.decorate("services", {
    agents: { build: () => ({ agent, mainModel: { qualifiedModelId: "openai:test" } }) },
    session: new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    ),
    approvals: new ApprovalGateway(new ApprovalRepository(db)),
    runLedger: new RunLedger(new DrizzleRunRepository(db)),
    runRegistry: new RunRegistry(),
    mcp: { ensureConnected: async () => {}, listTools: () => [] }
  });
  decorateAppApi(app);

  registerRunRoutes(app);
  await app.ready();
};

const post = async (payload: unknown) =>
  app.inject({
    method: "POST",
    url: "/api/v1/runs/stream",
    payload,
    headers: { accept: "text/event-stream" }
  });

const runRowCount = (sessionId: string): number =>
  (
    rawClient(db)
      .prepare("SELECT count(*) AS n FROM runs WHERE session_id = ?")
      .get(sessionId) as { n: number }
  ).n;

/** 会话里塞一条在飞的 run —— 模拟「刷新页面时上一轮还在跑」。 */
const seedRunningRun = (sessionId: string, runId: string): void => {
  rawClient(db)
    .prepare(
      `INSERT INTO runs (id, session_id, status, model, started_at)
       VALUES (?, ?, 'running', 'openai:test', datetime('now'))`
    )
    .run(runId, sessionId);
};

beforeEach(async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  await startApp();
});

afterEach(async () => {
  await app.close();
  closeDb(db);
});

/**
 * SSE 断连不再 abort 之后,这个 409 是「一个会话同时只跑一个 run」的唯一执行者。
 * 它红了就意味着刷新后再发一句会让两个 run 同时改 activeLeafId。
 */
describe("同会话并发守卫", () => {
  it("已有 run 在飞 → 409 + activeRunId,不多留 run 行", async () => {
    new DrizzleSessionRepository(db).create({ id: "session-1" });
    seedRunningRun("session-1", "run-live");

    const response = await post({ sessionId: "session-1", text: "再来一句", modelId: "openai:test" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: expect.stringContaining("还有一轮"),
      activeRunId: "run-live"
    });
    // 被拒的请求不该留下台账行:sessionId 在 prepareRunInput 返回后才赋值。
    expect(runRowCount("session-1")).toBe(1);
  });

  it("retry 分支同样被挡住", async () => {
    new DrizzleSessionRepository(db).create({ id: "session-1" });
    seedRunningRun("session-1", "run-live");

    const response = await post({ sessionId: "session-1", retryMessageId: "whatever" });

    expect(response.statusCode).toBe(409);
    expect(response.json().activeRunId).toBe("run-live");
  });

  it("在飞 run 收尾后同一会话可以继续发", async () => {
    new DrizzleSessionRepository(db).create({ id: "session-1" });
    seedRunningRun("session-1", "run-live");
    new DrizzleRunRepository(db).settle("run-live", { status: "completed", finishReason: "stop" });

    const response = await post({ sessionId: "session-1", text: "hi", modelId: "openai:test" });

    expect(response.statusCode).toBe(200);
  });

  it("新建会话不受影响(别的会话在跑不该挡住新会话)", async () => {
    new DrizzleSessionRepository(db).create({ id: "session-other" });
    seedRunningRun("session-other", "run-live");

    const response = await post({ text: "hi", modelId: "openai:test" });

    expect(response.statusCode).toBe(200);
  });
});
