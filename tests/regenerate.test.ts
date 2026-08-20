import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../apps/server/node_modules/fastify";

import { createAgent } from "../packages/harness/src/index.js";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { loadConfig } from "../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../apps/server/src/db/index.js";
import { ApprovalRepository } from "../apps/server/src/db/repositories/approval-repository.js";
import { DrizzleMessageRepository } from "../apps/server/src/db/repositories/message-repository.js";
import { DrizzleRunRepository } from "../apps/server/src/db/repositories/run-repository.js";
import { DrizzleSessionRepository } from "../apps/server/src/db/repositories/session-repository.js";
import { ApprovalGateway } from "../apps/server/src/services/approval-gateway.js";
import { RunLedger } from "../apps/server/src/services/runs/run-ledger.js";
import { RunRegistry } from "../apps/server/src/services/run-registry.js";
import { SessionService } from "../apps/server/src/services/session.js";
import { registerRunRoutes } from "../apps/server/src/routes/runs.js";
import { registerThreadRoutes } from "../apps/server/src/routes/threads.js";
import { loadAppSettings, replaceAppSettings } from "../apps/server/src/services/settings/app-settings.js";
import type { StoredMessage } from "../apps/server/src/db/repositories/types.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

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

let app: FastifyInstance;
let db: AppDatabase;

const startApp = async (): Promise<void> => {
  app = Fastify();
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    db,
    skills: []
  });
  app.decorate("services", {
    agents: {
      build: () => ({
        agent: createAgent({ model: textModel("reply"), tools: [], maxSteps: 3 }),
        mainModel: { qualifiedModelId: "openai:test" }
      }),
      resolveModels: () => ({ tool: { qualifiedModelId: "openai:test" } })
    },
    session: new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    ),
    approvals: new ApprovalGateway(new ApprovalRepository(db)),
    runLedger: new RunLedger(new DrizzleRunRepository(db)),
    runRegistry: new RunRegistry(),
    mcp: { ensureConnected: async () => {}, listTools: () => [] },
    workspaces: {} as never
  });

  registerRunRoutes(app);
  registerThreadRoutes(app);
  await app.ready();
};

beforeEach(async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);
  const settings = loadAppSettings(db, loadConfig({ env: {}, cwd: "/tmp" }));
  replaceAppSettings(db, loadConfig({ env: {}, cwd: "/tmp" }), {
    ...settings,
    security: { ...settings.security, autoApproveToolRequests: true }
  });
  await startApp();
});

afterEach(async () => {
  await app.close();
  closeDb(db);
});

const streamRun = async (
  body: unknown
): Promise<{ events: Array<{ type: string; [k: string]: unknown }>; status: number }> => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/runs/stream",
    payload: body,
    headers: { accept: "text/event-stream" }
  });

  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for (const line of response.body.split("\n")) {
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

const sessionRepo = (): DrizzleSessionRepository => new DrizzleSessionRepository(db);
const messageRepo = (): DrizzleMessageRepository => new DrizzleMessageRepository(db);
const service = (): SessionService => new SessionService(sessionRepo(), messageRepo());

/** 发一条消息,返回新会话 id。此时该会话应为 [user(A), assistant(v1)],activeLeaf = v1。 */
const startSession = async (): Promise<string> => {
  const { events, status } = await streamRun({ text: "hello", modelId: "openai:test" });
  expect(status).toBe(200);
  const start = events.find((e) => e.type === "run_start")!;
  return start.sessionId as string;
};

const allMessages = (sessionId: string): readonly StoredMessage[] =>
  messageRepo().findBySessionId(sessionId, { limit: 20 });

const assistants = (sessionId: string): readonly StoredMessage[] =>
  allMessages(sessionId).filter((m) => m.role === "assistant");

const users = (sessionId: string): readonly StoredMessage[] =>
  allMessages(sessionId).filter((m) => m.role === "user");

describe("T12 重生成 + 版本切换(API 级)", () => {
  it("send → regenerate → 同 slot 2 条消息、active_leaf = v2", async () => {
    const sessionId = await startSession();
    const v1 = assistants(sessionId)[0]!;

    const { status } = await streamRun({ sessionId, retryMessageId: v1.id });
    expect(status).toBe(200);

    const list = assistants(sessionId);
    expect(list).toHaveLength(2);
    const v2 = list[1]!;
    // v2 沿用 v1 的 parent/slot/depth
    expect(v2.slotId).toBe(v1.slotId);
    expect(v2.parentId).toBe(v1.parentId);
    expect(v2.depth).toBe(v1.depth);

    const sess = sessionRepo().findById(sessionId)!;
    expect(sess.activeLeafId).toBe(v2.id);
  });

  it("buildModelHistory 只含激活分支(v1 不在里面)", async () => {
    const sessionId = await startSession();
    const v1 = assistants(sessionId)[0]!;
    await streamRun({ sessionId, retryMessageId: v1.id });

    const history = service().buildModelHistory(db, sessionId);
    // 激活链 = [user, v2];v1 已被 v2 覆盖,不该出现在模型历史里。
    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history.messages[1]!.id).toBe(assistants(sessionId)[1]!.id);
  });

  it("retry 时历史末端是那条 user 消息(不含被重试的 v1)", async () => {
    const sessionId = await startSession();
    const v1 = assistants(sessionId)[0]!;
    await streamRun({ sessionId, retryMessageId: v1.id });

    // 模型不仅不含 v1 → 应从"被重试消息的父(user)"回溯,末端是 user。
    const history = service().buildModelHistory(db, sessionId);
    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // 那条 assistant 是 v2,不是 v1
    expect(history.messages[1]!.id).not.toBe(v1.id);
    expect(history.messages[1]!.id).toBe(assistants(sessionId)[1]!.id);
  });

  it("switch 回 v1 → 激活链到 v1 为止;再 switch 到 v2 → 恢复", async () => {
    const sessionId = await startSession();
    const v1 = assistants(sessionId)[0]!;
    await streamRun({ sessionId, retryMessageId: v1.id });

    // 切回 v1
    const back = await app.inject({
      method: "POST",
      url: `/api/v1/messages/${v1.id}/switch-version`
    });
    expect(back.statusCode).toBe(200);
    const backChain = back.json() as Array<{ id: string; siblingIds: readonly string[] }>;
    const a = users(sessionId)[0]!;
    expect(backChain.map((m) => m.id)).toEqual([a.id, v1.id]);
    // same slot 的两个版本都应出现在 siblingIds
    const v1row = backChain.find((m) => m.id === v1.id)!;
    expect(v1row.siblingIds).toHaveLength(2);

    // 再切到 v2 —— v2 的 parent 是 user(与 v1 同槽位),不是 v1 的子树
    const v2 = assistants(sessionId)[1]!;
    const fwd = await app.inject({
      method: "POST",
      url: `/api/v1/messages/${v2.id}/switch-version`
    });
    expect(fwd.statusCode).toBe(200);
    const fwdChain = fwd.json() as Array<{ id: string }>;
    expect(fwdChain.map((m) => m.id)).toEqual([a.id, v2.id]);
    expect(sessionRepo().findById(sessionId)!.activeLeafId).toBe(v2.id);
  });

  it("切到 v1 后发新消息 → 新消息 parent = v1(不是时间上最后一条)", async () => {
    const sessionId = await startSession();
    const v1 = assistants(sessionId)[0]!;
    await streamRun({ sessionId, retryMessageId: v1.id });
    const v2 = assistants(sessionId)[1]!;

    // 先切回 v1(activeLeaf 从 v2 → v1)
    await app.inject({ method: "POST", url: `/api/v1/messages/${v1.id}/switch-version` });

    // 再发新消息 —— 必须接在 v1 后面,而不是时间上最晚的 v2。
    const { status } = await streamRun({ sessionId, text: "continuation", modelId: "openai:test" });
    expect(status).toBe(200);

    const userMessages = users(sessionId);
    const continuation = userMessages[userMessages.length - 1]!;
    expect(continuation.parentId).toBe(v1.id);
    expect(continuation.parentId).not.toBe(v2.id);
    // 时间序里 v2 在 v1 之后,parent 若取"时间上最后一条"会错误指向 v2 —— 这里必须取 tree 里的 v1。
  });

  it("send 不带 modelId → 400(模型是 per-run 必选,没有全局默认兜底)", async () => {
    const { status } = await streamRun({ text: "hello" });
    expect(status).toBe(400);
  });

  it("retry 不带 modelId → 沿用会话记录的模型(上一轮选的那个)", async () => {
    const sessionId = await startSession();
    const v1 = assistants(sessionId)[0]!;

    // 会话记录里存着 send 那轮选的模型。
    expect(sessionRepo().findById(sessionId)?.model).toBe("openai:test");

    const { status } = await streamRun({ sessionId, retryMessageId: v1.id });
    expect(status).toBe(200);
    expect(assistants(sessionId)).toHaveLength(2);
  });

  it("非法 retry:非 assistant / 跨会话都无法重生成 → 400", async () => {
    const sessionId = await startSession();
    const a = users(sessionId)[0]!;
    const v1 = assistants(sessionId)[0]!;

    // 重生成一条 user 消息 → 400(只能重生成 assistant)
    const userRetry = await streamRun({ sessionId, retryMessageId: a.id });
    expect(userRetry.status).toBe(400);

    // 重生成另一条会话的 assistant → 400(跨会话)
    const otherId = await startSession();
    const otherV1 = assistants(otherId)[0]!;
    const cross = await streamRun({ sessionId, retryMessageId: otherV1.id });
    expect(cross.status).toBe(400);

    // 重生成"时间上很旧的一条 assistant"(它不是 activeLeaf)→ 400
    const { status: setupStatus } = await streamRun({ sessionId, retryMessageId: v1.id });
    expect(setupStatus).toBe(200);
    // 现在 activeLeaf = v2;再想重生成 v1 → 400
    const stale = await streamRun({ sessionId, retryMessageId: v1.id });
    expect(stale.status).toBe(400);
  });
});
