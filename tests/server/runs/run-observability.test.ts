import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { textResult, tool } from "../../../packages/harness/src/tools/tool.js";
import { z } from "zod";
import type { PipelineTool } from "../../../packages/harness/src/index.js";

import { loadConfig } from "../../../apps/server/src/config.js";
import { closeDb, initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { ApprovalRepository } from "../../../apps/server/src/modules/approvals/index.js";
import { DrizzleMessageRepository } from "../../../apps/server/src/modules/sessions/index.js";
import {
  RunEventRepository,
  createRunRecorder,
  createRunTrajectory,
} from "../../../apps/server/src/modules/observability/index.js";
import { DrizzleRunRepository } from "../../../apps/server/src/modules/runs/index.js";
import { runs, sessions } from "../../../apps/server/src/db/schema.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { ApprovalGateway } from "../../../apps/server/src/modules/approvals/index.js";
import { RunRegistry } from "../../../apps/server/src/modules/runs/index.js";
import { SessionService } from "../../../apps/server/src/modules/sessions/index.js";
import {
  SubagentTaskRepository,
  createSubagentProjection,
} from "../../../apps/server/src/modules/subagents/index.js";
import { query } from "../../../packages/harness/src/index.js";
import type { AgentFactory, ResolvedOptions } from "../../../apps/server/src/modules/runs/index.js";
import type { ModelBinding } from "../../../apps/server/src/modules/providers/index.js";
import { registerRunRoutes } from "../../../apps/server/src/modules/runs/index.js";
import { decorateAppApi } from "../../helpers/app-api.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 }
};

const textChunks = (text: string) => [
  { type: "stream-start" as const, warnings: [] as never[] },
  { type: "text-start" as const, id: "1" },
  { type: "text-delta" as const, id: "1", delta: text },
  { type: "text-end" as const, id: "1" },
  { type: "finish" as const, finishReason: "stop" as const, usage }
];

const textModel = (text: string): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: textChunks(text) })
    })
  });

const echoTool = tool({
  name: "echo",
  description: "回显输入",
  inputSchema: z.object({ msg: z.string() }),
  execute: async ({ msg }) => textResult(msg)
});

/** 第一步产 tool-call(echo),第二步产纯文本。 */
const toolThenTextModel = (text: string): MockLanguageModelV4 => {
  let callIndex = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const call = callIndex;
      callIndex += 1;
      if (call === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: "tc-1", toolName: "echo" },
              {
                type: "tool-call",
                toolCallId: "tc-1",
                toolName: "echo",
                input: JSON.stringify({ msg: "hello" })
              },
              { type: "finish", finishReason: "tool-calls", usage }
            ]
          })
        };
      }
      return { stream: simulateReadableStream({ chunks: textChunks(text) }) };
    }
  });
};

const waitFor = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

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

describe("run observability(route 级)", () => {
  let app: FastifyInstance;
  let db: AppDatabase;

  const startApp = async (
    model: MockLanguageModelV4,
    tools: readonly PipelineTool[] = []
  ): Promise<void> => {
    app = Fastify();
    app.decorate("infra", {
      config: loadConfig({ env: {}, cwd: "/tmp" }),
      db,
      skills: []
    });
    app.decorate("services", {
      // 关键:ledger 由 createRunTrajectory 从 query() 的消息流推 —— 这是要测的链路。
      agents: {
        build: (): ResolvedOptions => ({
          options: {
            model: { languageModel: model, id: "openai:test" },
            tools: [...tools],
            maxTurns: 5,
          },
          mainModel: testBinding("openai:test"),
          toolModel: testBinding("openai:test-tool"),
          callSettings: {},
        }),
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

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
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

  it("两个 Session 并行跑 run:事件各落各的 runId,seq 各自连续", async () => {
    await startApp(textModel("hello"));
    const [a, b] = await Promise.all([
      streamRun({ text: "hi", modelId: "openai:test" }),
      streamRun({ text: "hi", modelId: "openai:test" })
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const runIdA = (a.events.find((e) => e.type === "run_start") as { runId: string }).runId;
    const runIdB = (b.events.find((e) => e.type === "run_start") as { runId: string }).runId;
    expect(runIdA).not.toBe(runIdB);

    const repo = new RunEventRepository(db);
    for (const runId of [runIdA, runIdB]) {
      const rows = repo.listByRun(runId, { limit: 500 });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.runId === runId)).toBe(true);
      const seqs = rows.map((row) => row.seq).sort((x, y) => x - y);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i));
      const kinds = new Set(rows.map((row) => row.kind));
      expect(kinds.has("run_started")).toBe(true);
      expect(kinds.has("turn_started")).toBe(true);
      expect(kinds.has("step_started")).toBe(true);
      expect(kinds.has("model_call_started")).toBe(true);
      expect(kinds.has("assistant_message")).toBe(true);
      expect(kinds.has("turn_completed")).toBe(true);
      expect(kinds.has("run_completed")).toBe(true);
    }
  });

  it("含工具调用的 run:ledger 自带 Turn→Step→Request→Assistant→Tool 全套事件", async () => {
    await startApp(toolThenTextModel("done"), [echoTool]);
    const { events, status } = await streamRun({ text: "hi", modelId: "openai:test" });
    expect(status).toBe(200);
    const runId = (events.find((e) => e.type === "run_start") as { runId: string }).runId;

    const rows = new RunEventRepository(db)
      .listByRun(runId, { limit: 500 })
      .reverse(); // seq 升序
    const kinds = rows.map((row) => row.kind);

    // 骨架序列(允许中间夹 snapshot_ref / loop_transition 等):按序出现即满足投影需要。
    const skeleton = [
      "run_started",
      "routing_resolved",
      "turn_started",
      "request_snapshot",
      "step_started",
      "model_call_started",
      // model_first_token 改从 turn_complete.ttft_ms 推:时点后移到工具事件之后(消息流里 ttft 只能在调用结束时给)
      "tool_call_started",
      "model_first_token",
      "step_completed",
      "tool_call_completed",
      "assistant_message",
      "turn_completed",
      "run_completed"
    ];
    let cursor = 0;
    for (const kind of skeleton) {
      const found = kinds.indexOf(kind, cursor);
      expect(found, `缺少或乱序:${kind}(实际序列:${kinds.join(",")})`).toBeGreaterThanOrEqual(cursor);
      cursor = found + 1;
    }

    const toolCompleted = rows.find((row) => row.kind === "tool_call_completed");
    expect(toolCompleted).toBeDefined();
    expect(JSON.parse(toolCompleted!.payload)).toMatchObject({
      toolName: "echo",
      status: "success"
    });

    // 同一份 snapshot 不重复写正文:第二个 streamText 圈(若有)应出 ref 或没有第二条 snapshot
    const snapshots = rows.filter((row) => row.kind === "request_snapshot");
    expect(snapshots.length).toBe(1);
  });
});

describe("run observability(子代理)", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
  });

  afterEach(() => {
    closeDb(db);
  });

  const recorderDeps = () => ({
    db,
    logger: { warn: () => {} },
    enabled: true,
    captureLevel: "redacted" as const
  });

  const seedParent = (): void => {
    db.insert(sessions).values({ id: "s-1" }).run();
    db.insert(runs).values({ id: "parent-run", sessionId: "s-1" }).run();
  };

  /** 父模型第一步派子代理,第二步收尾(子代理消息经 harness 的 subagent 工具并入父流)。 */
  const dispatchingModel = (): MockLanguageModelV4 => {
    let call = 0;
    return new MockLanguageModelV4({
      doStream: async () => {
        call += 1;
        if (call > 1) return textModel("parent done").doStream({} as never);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call", toolCallId: "call-1", toolName: "subagent",
                input: JSON.stringify({ description: "t", prompt: "explore", subagent: "explorer" }),
              },
              { type: "finish", finishReason: "tool-calls", usage },
            ] as never,
          }),
        };
      },
    });
  };

  it("前台子代理:事件进父 Run、agent=taskId、与主 Agent 共用连续 seq", async () => {
    seedParent();
    const recorder = createRunRecorder(recorderDeps(), {
      runId: "parent-run",
      sessionId: "s-1"
    });
    recorder.record({ agent: "main", kind: "run_started" });

    // 子代理轨迹:同一 recorder、agent = taskId(与 coordinator 的 trajectoryForTask 同一装配)。
    const projection = createSubagentProjection({
      db,
      sessionId: "s-1",
      runId: "parent-run",
      model: "openai:test",
      trajectoryForTask: (taskId) => createRunTrajectory(
        { runId: recorder.runId, record: (event) => recorder.record({ ...event, agent: taskId }) },
        { provider: "openai", modelId: "test", callSettings: {} },
      ),
      emit: () => {},
    });
    const mainTrajectory = createRunTrajectory(recorder, {
      provider: "openai", modelId: "test", callSettings: {},
    });

    let taskId: string | undefined;
    for await (const message of query({
      prompt: [{ role: "user", content: "go" }],
      options: {
        model: { languageModel: dispatchingModel(), id: "openai:test" },
        canUseTool: async () => ({ behavior: "allow" }),
        agents: {
          explorer: {
            description: "e", prompt: "explorer", maxTurns: 3,
            model: { languageModel: textModel("sub answer"), id: "openai:test" },
          },
        },
      },
    })) {
      if (message.type === "system" && message.subtype === "task_started") taskId = message.task_id;
      if (projection.accepts(message)) projection.record(message);
      else mainTrajectory.record(message);
    }
    if (taskId === undefined) throw new Error("subagent never started");

    const rows = new RunEventRepository(db).listByRun("parent-run", { limit: 500 });
    const agents = new Set(rows.map((row) => row.agent));
    expect(agents.has("main")).toBe(true);
    expect(agents.has(taskId)).toBe(true);
    // 子代理事件带有 turn_started 等 harness 事件(不是只有壳)
    expect(rows.some((row) => row.agent === taskId && row.kind === "turn_started")).toBe(true);
    expect(rows.some((row) => row.agent === taskId && row.kind === "assistant_message")).toBe(true);
    // 任务行由 task_* 起止消息结算
    expect(new SubagentTaskRepository(db).findById(taskId)).toMatchObject({
      status: "done", result: "sub answer", parentToolCallId: "call-1",
    });
    // 共用一个 seq 序列且连续
    const seqs = rows.map((row) => row.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i));
  });


});

describe("run observability(harness 事件)", () => {
  it("同一 Run 内相同 snapshot 只写一次正文,后续记 request_snapshot_ref", () => {
    const db = initDb({ dbPath: ":memory:" });
    migrateDb(db);
    try {
      db.insert(sessions).values({ id: "s-1" }).run();
      db.insert(runs).values({ id: "r-1", sessionId: "s-1" }).run();
      const recorder = createRunRecorder(
        { db, logger: { warn: () => {} }, enabled: true, captureLevel: "redacted" },
        { runId: "r-1", sessionId: "s-1" }
      );
      // observer-bridge 已删:同 Run 的 snapshot 去重由 createRunTrajectory 做(§4.3 照搬)。
      const trajectory = createRunTrajectory(recorder, {
        provider: "openai",
        modelId: "gpt-4o",
        callSettings: { temperature: 0.1 },
      });

      // system/init 只带 messages 域;provider/model/callSettings 从装配期上下文给。
      const initMessage = (systemPrompt: string) => ({
        type: "system" as const,
        subtype: "init" as const,
        model: "openai:gpt-4o",
        tools: ["echo"],
        system_prompt: systemPrompt,
        parent_tool_use_id: null,
      });
      trajectory.record(initMessage("you are helpful"));
      trajectory.record(initMessage("you are helpful")); // 全同 → ref
      trajectory.record(initMessage("you are terse")); // 变了 → 新正文

      const rows = new RunEventRepository(db).listByRun("r-1", { limit: 10 }).reverse();
      // system/init 每条先落 turn_started 再落 snapshot:断言收敛到 snapshot 三连(去重语义不变)。
      expect(rows.filter((row) => row.kind !== "turn_started").map((row) => row.kind)).toEqual([
        "request_snapshot",
        "request_snapshot_ref",
        "request_snapshot"
      ]);
      const snapshots = rows.filter((row) => row.kind !== "turn_started");
      const ref = JSON.parse(snapshots[1]!.payload) as { refSeq: number };
      expect(ref.refSeq).toBe(snapshots[0]!.seq);
    } finally {
      closeDb(db);
    }
  });

  it("禁止隐式 current run:apps/server/src 里 grep currentRun 零命中", () => {
    const root = path.join(process.cwd(), "apps/server/src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const content = readFileSync(full, "utf8");
          if (content.includes("currentRun")) {
            offenders.push(full);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
