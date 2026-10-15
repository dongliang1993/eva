import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";

import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { loadConfig } from "../../../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import type { ModelResolution } from "../../../apps/server/src/modules/runs/index.js";
import type { ModelBinding } from "../../../apps/server/src/modules/providers/index.js";
import { DrizzleRunRepository, runStatusFor } from "../../../apps/server/src/modules/runs/index.js";
import { runs } from "../../../apps/server/src/db/schema.js";
import { ApprovalRepository } from "../../../apps/server/src/modules/approvals/index.js";
import { DrizzleMessageRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { AgentUnavailableError } from "../../../apps/server/src/modules/runs/index.js";
import { ApprovalGateway } from "../../../apps/server/src/modules/approvals/index.js";
import { RunRegistry } from "../../../apps/server/src/modules/runs/index.js";
import { SessionService } from "../../../apps/server/src/modules/sessions/index.js";
import { registerRunRoutes } from "../../../apps/server/src/modules/runs/index.js";
import { loadAppSettings, replaceAppSettings } from "../../../apps/server/src/modules/settings/index.js";
import { decorateAppApi } from "../../helpers/app-api.js";

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

/** build 桩的模型 binding(ModelResolution 需要的字段集)。 */
const testBinding = (qualifiedModelId: string): ModelBinding => ({
  slot: "tool",
  providerId: "openai",
  providerType: "openai",
  kind: "openai-compatible",
  qualifiedModelId,
  modelId: qualifiedModelId.split(":")[1] ?? qualifiedModelId,
  apiKey: "test-key",
});

/** build 桩:Options(model + maxTurns)+ 双模型 binding,Coordinator 拿它跑 query()。 */
const buildModelResolution = (model: MockLanguageModelV4): ModelResolution => ({
  options: {
    model: { languageModel: model, id: "openai:test" },
    tools: [],
    maxTurns: 3,
  },
  mainModel: testBinding("openai:test"),
  toolModel: testBinding("openai:test-tool"),
  callSettings: {},
});

let app: FastifyInstance;
let db: AppDatabase;
let harness: ModelResolution;

const startApp = async (models: ModelResolution, memoryAutomation?: object): Promise<void> => {
  app = Fastify();
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    db,
    skills: []
  });
  app.decorate("services", {
    agents: {
      build: () => models,
    },
    session: new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    ),
    approvals: new ApprovalGateway(new ApprovalRepository(db)),

    runRegistry: new RunRegistry(),
    ...(memoryAutomation ? { memoryAutomation } : {}),
    // 本用例不测 MCP:给个空 registry 桩,证明"没配 MCP 时 run 照常跑"
    mcp: { ensureConnected: async () => {}, listTools: () => [] }
  });
  decorateAppApi(app);

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

  harness = buildModelResolution(textModel("hello world"));
  await startApp(harness);
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

/**
 * 换一台「装不出 agent」的 app —— 模拟新装用户没配 provider。
 * 两个 503 用例共用:一个测已有会话(台账留下),一个测新建会话(回滚删掉)。
 */
const startAppWithUnavailableAgent = async (): Promise<void> => {
  await app.close();
  app = Fastify();
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    db,
    skills: []
  });
  app.decorate("services", {
    agents: {
      build: () => {
        throw new AgentUnavailableError("no provider configured");
      }
    },
    session: new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    ),
    approvals: new ApprovalGateway(new ApprovalRepository(db)),

    runRegistry: new RunRegistry(),
    mcp: { ensureConnected: async () => {}, listTools: () => [] }
  });
  decorateAppApi(app);
  registerRunRoutes(app);
  await app.ready();
};

describe("run 台账", () => {
  it("normal completion atomically enqueues post-run memory extraction", async () => {
    await app.close();
    const enqueued: unknown[] = [];
    let wakes = 0;
    await startApp(harness, {
      settingsSnapshot: () => ({
        enabled: true,
        autoRetrieve: true,
        autoSummarize: true,
        autoSummarizeMode: "review",
        maxRetrievedMemories: 5,
        maxRetrieveTokens: 1200
      }),
      retrieve: () => undefined,
      commitRetrieval: () => undefined,
      enqueue: (input: unknown) => {
        enqueued.push(input);
        return true;
      },
      wake: () => { wakes++; }
    });

    const result = await streamRun({ text: "remember my preference", modelId: "openai:test" });

    expect(result.status).toBe(200);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      modelId: "openai:test-tool",
      mode: "review"
    });
    expect(wakes).toBe(1);
  });

  it("正常完成 → runs 一行 completed,带 assistant_message_id 与路由双字段", async () => {
    const { events } = await streamRun({ text: "hi", modelId: "openai:test" });

    const end = events.find((e) => e.type === "end");
    expect(end).toBeDefined();
    expect(end!.finishReason).toBe("stop");

    const sqlite = rawClient(db);
    const run = sqlite.prepare("SELECT status, finish_reason, model, requested_model, assistant_message_id, usage, capture_level FROM runs").get() as {
      status: string;
      finish_reason: string;
      model: string;
      requested_model: string | null;
      assistant_message_id: string | null;
      usage: string | null;
      capture_level: string | null;
    };
    expect(run.status).toBe("completed");
    expect(run.finish_reason).toBe("stop");
    expect(run.model).toBe("openai:test");
    // Run 提前创建 + patchRouting —— requested 与 resolved 都有值。
    expect(run.requested_model).toBe("openai:test");
    expect(run.capture_level).toBe("redacted");
    expect(run.assistant_message_id).toBeTruthy();
    expect(run.usage).toBeTruthy();
  });

  it("模型解析失败 → run 行 status=error、failure_layer=routing、requested_model 有值 model 为空", async () => {
    await startAppWithUnavailableAgent();

    // 已有会话:503 回滚只删本次请求新建的会话(产品决策),老会话的台账要留下。
    new DrizzleSessionRepository(db).create({ id: "s-existing" });
    const { status } = await streamRun({ text: "hi", modelId: "openai:missing", sessionId: "s-existing" });
    expect(status).toBe(503);

    const run = runsRepo().findBySessionId("s-existing")[0];
    expect(run).toBeDefined();
    expect(run!.status).toBe("error");
    expect(run!.failureLayer).toBe("routing");
    expect(run!.requestedModel).toBe("openai:missing");
    expect(run!.model).toBeNull();
  });

  it("模型不可用时保留新会话、输入和失败 run", async () => {
    await startAppWithUnavailableAgent();

    const sessionRepo = new DrizzleSessionRepository(db);
    expect(sessionRepo.listAll(50)).toHaveLength(0);

    // 新装用户没配 provider 就点发送:不带 sessionId,服务端会先建会话再解析模型。
    const { status } = await streamRun({ text: "hi", modelId: "openai:missing" });
    expect(status).toBe(503);

    const sessions = sessionRepo.listAll(50);
    expect(sessions).toHaveLength(1);
    const failedRuns = runsRepo().findBySessionId(sessions[0]!.id);
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0]).toMatchObject({
      status: "error",
      requestedModel: "openai:missing",
      failureLayer: "routing",
    });
  });

  it("模型报错 → status error,error 字段非空", async () => {
    // 重新起一个会在流中途抛错的 agent(error 事件帧 → run 收成 error)
    await app.close();
    const errorAgent = buildModelResolution(new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "error", error: new Error("model blew up") }
          ]
        })
      }),
    }));
    await startApp(errorAgent);

    const { status } = await streamRun({ text: "hi", modelId: "openai:test" });

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
    expect(marked).toEqual(["stale-1"]);

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
    const { events } = await streamRun({ text: "hi", modelId: "openai:test", sessionId: "does-not-exist" });
    const runStart = events.find((e) => e.type === "run_start") as { sessionId: string } | undefined;
    expect(runStart).toBeDefined();
    expect(runStart!.sessionId).not.toBe("does-not-exist");
  });

  it("seq 在所有帧中严格单调递增", async () => {
    const { events } = await streamRun({ text: "hi", modelId: "openai:test" });
    const seqs = events.map((e) => e.seq as number);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(seqs[0]).toBe(1);
  });
});
