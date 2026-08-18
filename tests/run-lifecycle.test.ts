import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../apps/server/node_modules/fastify";

import { createAgent, type Agent } from "../packages/harness/src/index.js";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { loadConfig } from "../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import { DrizzleRunRepository, runStatusFor } from "../apps/server/src/db/repositories/run-repository.js";
import { ApprovalRepository } from "../apps/server/src/db/repositories/approval-repository.js";
import { DrizzleMessageRepository } from "../apps/server/src/db/repositories/message-repository.js";
import { DrizzleSessionRepository } from "../apps/server/src/db/repositories/session-repository.js";
import { ApprovalGateway } from "../apps/server/src/services/approval-gateway.js";
import { RunRegistry } from "../apps/server/src/services/run-registry.js";
import { SessionService } from "../apps/server/src/services/session.js";
import { registerRunRoutes } from "../apps/server/src/routes/runs.js";
import { loadAppSettings, replaceAppSettings } from "../apps/server/src/services/settings/app-settings.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

/** 单步纯文本流的模型 —— 正常完成。 */
const textModel = (text: string): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: text },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: "stop", usage }
        ]
      })
    })
  });

const rawClient = (db: AppDatabase): import("better-sqlite3").Database =>
  (db as unknown as { $client: import("better-sqlite3").Database }).$client;

const buildAgent = (model: MockLanguageModelV4): Agent =>
  createAgent({
    model,
    tools: [],
    maxSteps: 3
  });

interface Harness {
  readonly agent: Agent;
  readonly mainModel: { qualifiedModelId: string };
}

let app: FastifyInstance;
let db: AppDatabase;
let harness: Harness;

const startApp = async (agent: Agent): Promise<void> => {
  app = Fastify();
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    db,
    skills: []
  });
  app.decorate("services", {
    agents: {
      resolve: () => ({ agent, mainModel: { qualifiedModelId: "openai:test" } })
    },
    session: new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    ),
    approvals: new ApprovalGateway(new ApprovalRepository(db)),
    runRegistry: new RunRegistry(),
    // 本用例不测 MCP:给个空 registry 桩,证明"没配 MCP 时 run 照常跑"
    mcp: { ensureConnected: async () => {}, listTools: () => [] }
  });

  registerRunRoutes(app);
  await app.ready();
};

beforeEach(async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);

  // autoApprove 打开,审批短路(本测试聚焦 run 台账与契约,审批由 approval-flow 覆盖)
  const settings = loadAppSettings(db, loadConfig({ env: {}, cwd: "/tmp" }));
  replaceAppSettings(db, loadConfig({ env: {}, cwd: "/tmp" }), {
    ...settings,
    security: { ...settings.security, autoApproveToolRequests: true }
  });

  harness = { agent: buildAgent(textModel("hello world")), mainModel: { qualifiedModelId: "openai:test" } };
  await startApp(harness.agent);
});

afterEach(async () => {
  await app.close();
  closeDb(db);
});

const streamRun = async (body: unknown): Promise<{ events: Array<{ type: string; [k: string]: unknown }>; status: number }> => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/runs/stream",
    payload: body,
    headers: { accept: "text/event-stream" }
  });

  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const dataLines = response.body.split("\n");
  for (const line of dataLines) {
    if (line.startsWith("data: ")) {
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // ignore
      }
    }
  }

  return { events, status: response.statusCode };
};

const runsRepo = (): DrizzleRunRepository => new DrizzleRunRepository(db);

describe("run 台账", () => {
  it("正常完成 → runs 一行 completed,带 assistant_message_id", async () => {
    const { events } = await streamRun({ text: "hi" });

    const end = events.find((e) => e.type === "end");
    expect(end).toBeDefined();
    expect(end!.finishReason).toBe("stop");

    const sqlite = rawClient(db);
    const run = sqlite.prepare("SELECT status, finish_reason, model, assistant_message_id, usage FROM runs").get() as {
      status: string;
      finish_reason: string;
      model: string;
      assistant_message_id: string | null;
      usage: string | null;
    };
    expect(run.status).toBe("completed");
    expect(run.finish_reason).toBe("stop");
    expect(run.model).toBe("openai:test");
    expect(run.assistant_message_id).toBeTruthy();
    expect(run.usage).toBeTruthy();
  });

  it("模型报错 → status error,error 字段非空", async () => {
    // 重新起一个会在流中途抛错的 agent(error 事件帧 → run 收成 error)
    await app.close();
    const errorAgent = createAgent({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "error", error: new Error("model blew up") }
            ]
          })
        })
      }),
      tools: [],
      maxSteps: 3
    });
    await startApp(errorAgent);

    const { status } = await streamRun({ text: "hi" });

    // 错误在写头之后才发生,所以是 200 + error 帧
    expect(status).toBe(200);

    const sessions = new DrizzleSessionRepository(db).listAll(5);
    expect(sessions.length).toBeGreaterThan(0);
    const run = runsRepo().findBySessionId(sessions[0]!.id)[0];
    expect(run).toBeDefined();
    expect(run!.status).toBe("error");
    expect(run!.error).toContain("blew up");
  });

  it("failStale 把重启前的 running 收成 error", () => {
    const sqlite = rawClient(db);
    // 先建一个真实 session 满足外键,再塞一行 running(模拟崩溃残留)
    new DrizzleSessionRepository(db).create({
      id: "session-x",
    });
    sqlite.prepare(
      `INSERT INTO runs (id, session_id, status, model, started_at) VALUES (?, ?, 'running', 'openai:test', datetime('now'))`
    ).run("stale-1", "session-x");

    const marked = runsRepo().failStale();
    expect(marked).toBe(1);

    const row = sqlite.prepare("SELECT status, error FROM runs WHERE id = ?").get("stale-1") as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe("error");
    expect(row.error).toContain("restarted");
  });

  it("runStatusFor 映射四种 finishReason", () => {
    expect(runStatusFor("stop")).toBe("completed");
    expect(runStatusFor("aborted")).toBe("aborted");
    expect(runStatusFor("error")).toBe("error");
    expect(runStatusFor("max-steps")).toBe("completed");
  });
});

describe("契约", () => {
  it("body 缺 text → 400", async () => {
    const { status } = await streamRun({});
    expect(status).toBe(400);
  });

  it("body 带遗留的 messages[] 而没有 text → 400(不再静默接受)", async () => {
    const { status } = await streamRun({ messages: [{ role: "user", content: "hi" }] });
    expect(status).toBe(400);
  });

  it("未知 sessionId → 当成新会话,run_start 帧带回新 id", async () => {
    const { events } = await streamRun({ text: "hi", sessionId: "does-not-exist" });
    const runStart = events.find((e) => e.type === "run_start") as { sessionId: string } | undefined;
    expect(runStart).toBeDefined();
    expect(runStart!.sessionId).not.toBe("does-not-exist");
  });

  it("seq 在所有帧中严格单调递增", async () => {
    const { events } = await streamRun({ text: "hi" });
    const seqs = events.map((e) => e.seq as number);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(seqs[0]).toBe(1);
  });
});