import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { createAgent, type Agent } from "../../../packages/harness/src/index.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { ApprovalRepository } from "../../../apps/server/src/db/repositories/approval-repository.js";
import { DrizzleMessageRepository } from "../../../apps/server/src/db/repositories/message-repository.js";
import { DrizzleRunRepository } from "../../../apps/server/src/db/repositories/run-repository.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/db/repositories/session-repository.js";
import { ApprovalGateway } from "../../../apps/server/src/services/approval-gateway.js";
import { RunLedger } from "../../../apps/server/src/services/runs/run-ledger.js";
import { RunRegistry } from "../../../apps/server/src/services/run-registry.js";
import { SessionService } from "../../../apps/server/src/services/session.js";
import { registerRunRoutes } from "../../../apps/server/src/routes/runs.js";
import { loadAppSettings, replaceAppSettings } from "../../../apps/server/src/services/settings/app-settings.js";
import { buildActiveChain } from "../../../apps/server/src/services/message-tree.js";
import { decorateAppApi } from "../../helpers/app-api.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

const textChunks = (id: string, text: string) => [
  { type: "stream-start" as const, warnings: [] },
  { type: "text-start" as const, id },
  { type: "text-delta" as const, id, delta: text },
  { type: "text-end" as const, id },
  { type: "finish" as const, finishReason: "stop" as const, usage }
];

/**
 * 第一步:派一个后台子代理(子代理会 report);之后每步只说话。
 * 真实链路:subagent 工具 → runFork → report → ReportGateway → loop 注入。
 */
const forkingModel = (): MockLanguageModelV4 => {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const index = call;
      call += 1;

      if (index === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "a" },
              { type: "text-delta", id: "a", delta: "派一个子代理" },
              { type: "text-end", id: "a" },
              {
                type: "tool-call",
                toolCallId: "call_00",
                toolName: "subagent",
                input: JSON.stringify({
                  description: "深挖 server",
                  prompt: "调查 apps/server"
                })
              },
              { type: "finish", finishReason: "tool-calls", usage }
            ]
          })
        };
      }

      // 注入通知后的续跑:说一句全新的话(用于断言不重复前一条正文)。
      return { stream: simulateReadableStream({ chunks: textChunks(`b${index}`, "根据报告回应") }) };
    }
  });
};

/** 子代理:调 report 交付结论,然后收尾。 */
const reportingSubagentModel = (): MockLanguageModelV4 => {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const index = call;
      call += 1;

      if (index === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "sub_call_00",
                toolName: "report",
                input: JSON.stringify({ output: "子代理结论:三层依赖" })
              },
              { type: "finish", finishReason: "tool-calls", usage }
            ]
          })
        };
      }

      return { stream: simulateReadableStream({ chunks: textChunks("s", "done") }) };
    }
  });
};

let app: FastifyInstance;
let db: AppDatabase;

const startApp = async (agentOverride?: Agent): Promise<void> => {
  const mainAgent = agentOverride ?? createAgent({ model: forkingModel(), tools: [], maxSteps: 6 });

  app = Fastify();
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    db,
    skills: []
  });
  app.decorate("services", {
    agents: {
      build: () => ({
        agent: mainAgent,
        mainModel: { qualifiedModelId: "openai:test" }
      }),
      // 子代理装配:真实 createAgent + report 工具由 runner 注入(extraTools)。
      buildSubagent: ({ extraTools }: { extraTools?: readonly unknown[] }) =>
        createAgent({
          model: reportingSubagentModel(),
          tools: [...((extraTools ?? []) as never[])],
          maxSteps: 4
        })
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
  decorateAppApi(app);

  registerRunRoutes(app);
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
): Promise<Array<{ type: string; [k: string]: unknown }>> => {
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
  return events;
};

const activeChain = (sessionId: string) => {
  const all = new DrizzleMessageRepository(db).findBySessionId(sessionId, { limit: 100 });
  const leaf = new DrizzleSessionRepository(db).findById(sessionId)?.activeLeafId ?? null;
  return buildActiveChain(all, leaf);
};

/** 第一步用前台派发(run_in_background=false),结果由工具返回值直达。 */
const foregroundForkingModel = (): MockLanguageModelV4 => {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const index = call;
      call += 1;

      if (index === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call_00",
                toolName: "subagent",
                input: JSON.stringify({
                  description: "前台读 server",
                  prompt: "调查 apps/server",
                  run_in_background: false
                })
              },
              { type: "finish", finishReason: "tool-calls", usage }
            ]
          })
        };
      }

      return { stream: simulateReadableStream({ chunks: textChunks(`f${index}`, "已拿到结果") }) };
    }
  });
};

describe("子代理通知的消息边界 (S7 push 落库)", () => {
  it("主链变成 user → assistant(派发) → user(通知) → assistant(回应)", async () => {
    const events = await streamRun({ text: "并行研究一下", modelId: "openai:test" });
    const sessionId = String(events.find((e) => e.type === "run_start")?.sessionId);

    const chain = activeChain(sessionId);
    const shape = chain.map((m) => ({
      role: m.role,
      notice: m.message.metadata?.noticeKind
    }));

    expect(shape).toEqual([
      { role: "user", notice: undefined },
      { role: "assistant", notice: undefined },
      { role: "user", notice: "subagent_reported" },
      { role: "assistant", notice: undefined }
    ]);
  });

  it("通知条带任务名与报告内容(刷新后仍在上下文里)", async () => {
    const events = await streamRun({ text: "并行研究一下", modelId: "openai:test" });
    const sessionId = String(events.find((e) => e.type === "run_start")?.sessionId);

    const notice = activeChain(sessionId).find(
      (m) => m.message.metadata?.noticeKind !== undefined
    );

    expect(notice?.message.metadata?.noticeDescription).toBe("深挖 server");
    const text = notice?.message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    expect(text).toContain("子代理结论:三层依赖");
  });

  it("续跑那条 assistant 不重复派发那条的正文(builder 必须换新)", async () => {
    const events = await streamRun({ text: "并行研究一下", modelId: "openai:test" });
    const sessionId = String(events.find((e) => e.type === "run_start")?.sessionId);

    const assistants = activeChain(sessionId).filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);

    const textOf = (m: (typeof assistants)[number]) =>
      m.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

    expect(textOf(assistants[0]!)).toContain("派一个子代理");
    expect(textOf(assistants[1]!)).toContain("根据报告回应");
    // 关键:第二条绝不能带上第一条的正文。
    expect(textOf(assistants[1]!)).not.toContain("派一个子代理");
  });

  it("子代理进程消息仍被隔离在主链之外(parentToolCallId 红线)", async () => {
    const events = await streamRun({ text: "并行研究一下", modelId: "openai:test" });
    const sessionId = String(events.find((e) => e.type === "run_start")?.sessionId);

    const all = new DrizzleMessageRepository(db).findBySessionId(sessionId, { limit: 100 });
    const subagentRows = all.filter((m) => m.parentToolCallId !== null);

    // 子代理确实落了消息(brief + assistant),但一条都不在主链上。
    expect(subagentRows.length).toBeGreaterThan(0);
    expect(activeChain(sessionId).every((m) => m.parentToolCallId === null)).toBe(true);
  });

  it("SSE 里有 notice-injected 与 subagent_report 帧", async () => {
    const events = await streamRun({ text: "并行研究一下", modelId: "openai:test" });

    expect(events.some((e) => e.type === "subagent_report")).toBe(true);
    expect(events.some((e) => e.type === "notice-injected")).toBe(true);
    // 且没有任何 join/轮询工具的痕迹。
    expect(events.some((e) => String(e.toolName ?? "") === "TaskOutput")).toBe(false);
  });

  it("runs 台账的 assistant_message_id 指向最后一条 assistant", async () => {
    const events = await streamRun({ text: "并行研究一下", modelId: "openai:test" });
    const sessionId = String(events.find((e) => e.type === "run_start")?.sessionId);

    const assistants = activeChain(sessionId).filter((m) => m.role === "assistant");
    const row = (db as unknown as { $client: import("better-sqlite3").Database }).$client
      .prepare("SELECT assistant_message_id FROM runs LIMIT 1")
      .get() as { assistant_message_id: string };

    expect(row.assistant_message_id).toBe(assistants.at(-1)!.id);
  });

  // 前台派发的结果由工具返回值直达模型;再推一条通知会让它把同一份内容读两遍
  // (实测第二条 assistant 只会说"这就是我刚转述的那份,一致")。
  it("前台派发不注入通知 —— 结果已由工具返回值带回,不重复投递", async () => {
    await app.close();
    const mainAgent = createAgent({ model: foregroundForkingModel(), tools: [], maxSteps: 6 });
    await startApp(mainAgent);

    const events = await streamRun({ text: "前台派一个", modelId: "openai:test" });
    const sessionId = String(events.find((e) => e.type === "run_start")?.sessionId);

    expect(events.some((e) => e.type === "notice-injected")).toBe(false);

    const chain = activeChain(sessionId);
    expect(chain.some((m) => m.message.metadata?.noticeKind !== undefined)).toBe(false);
    // 一轮一条 assistant,不因通知被切成两条。
    expect(chain.filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});
