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
import { runs } from "../apps/server/src/db/schema.js";
import { ApprovalRepository } from "../apps/server/src/db/repositories/approval-repository.js";
import { DrizzleMessageRepository } from "../apps/server/src/db/repositories/message-repository.js";
import { DrizzleSessionRepository } from "../apps/server/src/db/repositories/session-repository.js";
import { AgentUnavailableError, type AgentFactory } from "../apps/server/src/services/agent-factory.js";
import { ApprovalGateway } from "../apps/server/src/services/approval-gateway.js";
import { RunLedger } from "../apps/server/src/services/runs/run-ledger.js";
import { RunRegistry } from "../apps/server/src/services/run-registry.js";
import { SessionService } from "../apps/server/src/services/session.js";
import { SubagentRunner } from "../apps/server/src/services/subagents/subagent-runner.js";
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
      build: () => ({ agent, mainModel: { qualifiedModelId: "openai:test" } })
    },
    session: new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    ),
    approvals: new ApprovalGateway(new ApprovalRepository(db)),
    runLedger: new RunLedger(new DrizzleRunRepository(db)),
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
    runLedger: new RunLedger(new DrizzleRunRepository(db)),
    runRegistry: new RunRegistry(),
    mcp: { ensureConnected: async () => {}, listTools: () => [] }
  });
  registerRunRoutes(app);
  await app.ready();
};

describe("run 台账", () => {
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
    // T48:Run 提前创建 + patchRouting —— requested 与 resolved 都有值。
    expect(run.requested_model).toBe("openai:test");
    expect(run.capture_level).toBe("redacted");
    expect(run.assistant_message_id).toBeTruthy();
    expect(run.usage).toBeTruthy();
  });

  it("T48:模型解析失败 → run 行 status=error、failure_layer=routing、requested_model 有值 model 为空", async () => {
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

  it("T48 回滚:模型不可用且会话是本次请求新建的 → 503 且不留下空会话", async () => {
    await startAppWithUnavailableAgent();

    const sessionRepo = new DrizzleSessionRepository(db);
    expect(sessionRepo.listAll(50)).toHaveLength(0);

    // 新装用户没配 provider 就点发送:不带 sessionId,服务端会先建会话再解析模型。
    const { status } = await streamRun({ text: "hi", modelId: "openai:missing" });
    expect(status).toBe(503);

    // 产品决策(routes/runs.ts 的 AgentUnavailableError 分支):回滚只删本次新建的会话 ——
    // 否则没配好 API key 的新装用户每点一次发送就攒一条空会话。
    // 这条断言存在的意义:Wave 1 把收尾逻辑搬进 RunFinalizer 时,这个回滚极易被漏掉。
    expect(sessionRepo.listAll(50)).toHaveLength(0);

    // runs.session_id 是 ON DELETE CASCADE —— 会话没了,那条 routing 失败的台账行随之消失。
    // 刻意如此:会话都不存在了,留一条指向它的 run 行只会让台账里出现悬空引用。
    expect(db.select().from(runs).all()).toHaveLength(0);
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

describe("后台子代理 Run(T48)", () => {
  it("独立 runs 行:父子字段正确,父 Run completed 之后子 Run 独立 settle", async () => {
    new DrizzleSessionRepository(db).create({ id: "s-sub" });
    const repo = runsRepo();
    repo.start({ id: "parent-run", sessionId: "s-sub", model: "openai:test", userMessageId: "m1" });

    // gate 挡住子代理的流式响应 —— 保证父 Run 先 settle,子代理还活着。
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedAgent = createAgent({
      model: new MockLanguageModelV4({
        doStream: async () => {
          await gate;
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "1" },
                { type: "text-delta", id: "1", delta: "done" },
                { type: "text-end", id: "1" },
                { type: "finish", finishReason: "stop", usage }
              ]
            })
          };
        }
      }),
      tools: [],
      maxSteps: 3
    });

    const runner = new SubagentRunner(
      { buildSubagent: () => gatedAgent } as unknown as AgentFactory,
      {
        sessionId: "s-sub",
        db,
        runId: "parent-run",
        model: "openai:test",
        captureLevel: "redacted"
      }
    );

    const forked = await runner.runFork({
      background: true,
      prompt: "explore the repo",
      subagentType: "explorer",
      description: "找一下入口文件",
      taskId: "task-1",
      parentToolCallId: "call-1"
    });
    expect(forked).toEqual({ taskId: "task-1" });

    // 子 Run 行随 fork 建出,仍在飞;父子字段对得上。
    const child = repo.findBySessionId("s-sub").find((row) => row.parentRunId === "parent-run");
    expect(child).toBeDefined();
    expect(child!.backgroundTaskId).toBe("task-1");
    expect(child!.status).toBe("running");
    expect(child!.model).toBe("openai:test");
    expect(child!.captureLevel).toBe("redacted");

    // background_task_id → 任务行能反查 subagent_type 与 parent_tool_call_id。
    const task = rawClient(db)
      .prepare("SELECT subagent_type, parent_tool_call_id FROM background_tasks WHERE id = ?")
      .get("task-1") as { subagent_type: string; parent_tool_call_id: string };
    expect(task.subagent_type).toBe("explorer");
    expect(task.parent_tool_call_id).toBe("call-1");

    // 父 Run 先 completed,子代理仍在跑(gate 未放)。
    repo.settle("parent-run", { status: "completed" });
    release();

    const waitFor = async (cond: () => boolean): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error("waitFor timeout");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await waitFor(() => repo.findById(child!.id)!.status !== "running");

    // 子 Run 独立 settle;父 Run 的终态不被改写。
    expect(repo.findById(child!.id)!.status).toBe("completed");
    expect(repo.findById("parent-run")!.status).toBe("completed");
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
