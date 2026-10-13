import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import type { Options, PipelineTool } from "../../../packages/harness/src/index.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import {
  closeDb,
  initDb,
  migrateDb,
  type AppDatabase
} from "../../../apps/server/src/db/index.js";
import { ApprovalRepository } from "../../../apps/server/src/modules/approvals/index.js";
import { DrizzleMessageRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { DrizzleRunRepository } from "../../../apps/server/src/modules/runs/index.js";
import type { AgentFactory, ResolvedOptions } from "../../../apps/server/src/modules/runs/index.js";
import type { ModelBinding } from "../../../apps/server/src/modules/providers/index.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { ApprovalGateway } from "../../../apps/server/src/modules/approvals/index.js";
import { RunRegistry } from "../../../apps/server/src/modules/runs/index.js";
import { SessionService } from "../../../apps/server/src/modules/sessions/index.js";
import { registerRunRoutes } from "../../../apps/server/src/modules/runs/index.js";
import { loadAppSettings, replaceAppSettings } from "../../../apps/server/src/modules/settings/index.js";
import { buildActiveChain } from "../../../apps/server/src/modules/sessions/index.js";
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
 * 第一步派一个 awaited 子代理；工具结果回到同一工作历史后继续生成。
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

      // 工具结果后的续跑：说一句全新的话（用于断言不重复前一条正文）。
      return { stream: simulateReadableStream({ chunks: textChunks(`b${index}`, "根据报告回应") }) };
    }
  });
};

const reportingSubagentModel = (): MockLanguageModelV4 => new MockLanguageModelV4({
  doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks("s", "子代理结论:三层依赖") }) }),
});

let app: FastifyInstance;
let db: AppDatabase;

/** build 桩的模型 binding(ResolvedOptions 需要的字段集)。 */
const testBinding = (qualifiedModelId: string): ModelBinding => ({
  slot: "tool",
  providerId: "openai",
  providerType: "openai",
  kind: "openai-compatible",
  qualifiedModelId,
  modelId: qualifiedModelId.split(":")[1] ?? qualifiedModelId,
  apiKey: "test-key",
});

/** build/buildSubagentOptions 桩:真实 AgentFactory 的两个装配口(类型对齐签名)。 */
const stubAgentFactory = (): AgentFactory =>
  ({
    build: (): ResolvedOptions => ({
      options: {
        model: { languageModel: forkingModel(), id: "openai:test" },
        tools: [],
        maxTurns: 6,
        // 测试环境无审批 UI:全放行(生产由权限链注入)。
        canUseTool: async () => ({ behavior: "allow" as const })
      },
      mainModel: testBinding("openai:test"),
      toolModel: testBinding("openai:test-tool"),
      callSettings: {}
    }),
    // 子代理装配:返回 Options(真实 buildSubagentOptions 的形状),
    // SubagentRunner 拿它跑 query(),并接收本轮冻结的附加能力。
    buildSubagentOptions: (input: {
      readonly extraTools?: readonly PipelineTool[];
    }): Options => ({
      model: { languageModel: reportingSubagentModel(), id: "openai:test-tool" },
      tools: [...(input.extraTools ?? [])],
      systemPrompt: "子代理",
      maxTurns: 4,
      // 测试环境无审批 UI:子代理的权限链全放行(生产由 SubagentRunner 注入)。
      canUseTool: async () => ({ behavior: "allow" as const })
    }),
  }) as AgentFactory;

const startApp = async (): Promise<void> => {
  app = Fastify();
  app.decorate("infra", {
    config: loadConfig({ env: {}, cwd: "/tmp" }),
    db,
    skills: []
  });
  app.decorate("services", {
    // build/buildSubagentOptions 桩:真实 AgentFactory 的两个装配口,
    // 主/子 mock 模型在这里区分(生产由 provider 解析出 ModelBinding)。
    agents: stubAgentFactory(),
    session: new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    ),
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

describe("awaited subagents", () => {
  it("child result returns through the tool and stays in one assistant message", async () => {
    const events = await streamRun({ text: "研究一下", modelId: "openai:test" });
    const sessionId = String(events.find(e => e.type === "run_start")?.sessionId);
    const chain = activeChain(sessionId);
    expect(chain.map(m => m.role)).toEqual(["user", "assistant"]);
    const result = events.find(e => e.type === "tool-result" && e.toolName === "subagent");
    expect(result?.output).toContain("子代理结论:三层依赖");
    const all = new DrizzleMessageRepository(db).findBySessionId(sessionId, { limit: 100 });
    expect(all.filter(m => m.parentToolCallId !== null)).toHaveLength(2);
    expect(all.find(m => m.parentToolCallId !== null && m.role === "assistant")?.message.metadata?.model)
      .toBe("openai:test-tool");
    expect(chain.every(m => m.parentToolCallId === null)).toBe(true);
    expect(events.some(e => e.type === "subagent_update")).toBe(true);
  });
});
