import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import {
  buildTool,
  createAgent,
  type AgentObserver,
  type AgentTelemetryEvent,
  type AgentTool
} from "../../../packages/harness/src/index.js";
import { loadConfig } from "../../../apps/server/src/config.js";
import { closeDb, initDb, migrateDb, type AppDatabase } from "../../../apps/server/src/db/index.js";
import { ApprovalRepository } from "../../../apps/server/src/modules/approvals/index.js";
import { DrizzleMessageRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { RunEventRepository } from "../../../apps/server/src/modules/observability/index.js";
import { DrizzleRunRepository } from "../../../apps/server/src/modules/runs/index.js";
import { runs, sessions } from "../../../apps/server/src/db/schema.js";
import { DrizzleSessionRepository } from "../../../apps/server/src/modules/sessions/index.js";
import { ApprovalGateway } from "../../../apps/server/src/modules/approvals/index.js";
import { createObserverBridge, fanout } from "../../../apps/server/src/modules/observability/index.js";
import { createRunRecorder } from "../../../apps/server/src/modules/observability/index.js";
import { RunLedger } from "../../../apps/server/src/modules/runs/index.js";
import { RunRegistry } from "../../../apps/server/src/modules/runs/index.js";
import { SessionService } from "../../../apps/server/src/modules/sessions/index.js";
import { SubagentRunner } from "../../../apps/server/src/modules/subagents/index.js";
import type { AgentFactory } from "../../../apps/server/src/modules/runs/index.js";
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

const echoTool = buildTool({
  name: "echo",
  description: "回显输入",
  inputSchema: z.object({ msg: z.string() }),
  execute: async ({ msg }) => msg
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

describe("run observability(T49)route 级", () => {
  let app: FastifyInstance;
  let db: AppDatabase;

  const startApp = async (
    model: MockLanguageModelV4,
    tools: readonly AgentTool[] = []
  ): Promise<void> => {
    app = Fastify();
    app.decorate("infra", {
      config: loadConfig({ env: {}, cwd: "/tmp" }),
      db,
      skills: []
    });
    app.decorate("services", {
      agents: {
        // 关键:把路由给的 run-scoped observer 真接进 agent —— 这是 T49 要测的链路。
        build: (options: { observer?: AgentObserver }) => ({
          agent: createAgent({
            model,
            tools: [...tools],
            maxSteps: 5,
            ...(options.observer !== undefined ? { observer: options.observer } : {})
          }),
          mainModel: { qualifiedModelId: "openai:test" }
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
      "skills_selected",
      "routing_resolved",
      "turn_started",
      "request_snapshot",
      "step_started",
      "model_call_started",
      "model_first_token",
      "tool_call_started",
      "tool_call_completed",
      "step_completed",
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

describe("run observability(T49)子代理", () => {
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

  const stubFactory = (model: MockLanguageModelV4): AgentFactory =>
    ({
      buildSubagent: (options: { observer?: AgentObserver }) =>
        createAgent({
          model,
          tools: [],
          maxSteps: 3,
          ...(options.observer !== undefined ? { observer: options.observer } : {})
        })
    }) as unknown as AgentFactory;

  it("前台子代理:事件进父 Run、agent=taskId、与主 Agent 共用连续 seq", async () => {
    seedParent();
    const recorder = createRunRecorder(recorderDeps(), {
      runId: "parent-run",
      sessionId: "s-1"
    });
    const bridge = createObserverBridge(recorder);
    recorder.record({ agent: "main", kind: "run_started" });

    const runner = new SubagentRunner(stubFactory(textModel("sub answer")), {
      sessionId: "s-1",
      db,
      runId: "parent-run",
      model: "openai:test",
      observerForTask: (taskId) => bridge.forAgent(taskId)
    });

    const result = await runner.runFork({
      background: false,
      prompt: "explore",
      subagentType: "explorer",
      description: "t",
      taskId: "task-f1",
      parentToolCallId: "call-1"
    });
    expect("text" in result).toBe(true);

    const rows = new RunEventRepository(db).listByRun("parent-run", { limit: 500 });
    const agents = new Set(rows.map((row) => row.agent));
    expect(agents.has("main")).toBe(true);
    expect(agents.has("task-f1")).toBe(true);
    // 子代理事件带有 turn_started 等 harness 事件(不是只有壳)
    expect(rows.some((row) => row.agent === "task-f1" && row.kind === "turn_started")).toBe(true);
    expect(rows.some((row) => row.agent === "task-f1" && row.kind === "assistant_message")).toBe(true);
    // 共用一个 seq 序列且连续
    const seqs = rows.map((row) => row.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i));
  });

  it("后台子代理:事件全在自己的 Run,父 Run ledger 无子代理事件", async () => {
    seedParent();
    const parentRecorder = createRunRecorder(recorderDeps(), {
      runId: "parent-run",
      sessionId: "s-1"
    });
    parentRecorder.record({ agent: "main", kind: "run_started" });

    const runner = new SubagentRunner(stubFactory(textModel("bg answer")), {
      sessionId: "s-1",
      db,
      runId: "parent-run",
      model: "openai:test",
      createChildObserver: (childRunId, taskId) =>
        createObserverBridge(
          createRunRecorder(recorderDeps(), { runId: childRunId, sessionId: "s-1" })
        ).forAgent(taskId)
    });

    await runner.runFork({
      background: true,
      prompt: "explore",
      subagentType: "explorer",
      description: "t",
      taskId: "task-b1",
      parentToolCallId: "call-1"
    });

    const runsRepo = new DrizzleRunRepository(db);
    const child = runsRepo.findBySessionId("s-1").find((row) => row.parentRunId === "parent-run");
    expect(child).toBeDefined();
    await waitFor(() => runsRepo.findById(child!.id)!.status !== "running");

    const eventsRepo = new RunEventRepository(db);
    const childEvents = eventsRepo.listByRun(child!.id, { limit: 500 });
    expect(childEvents.length).toBeGreaterThan(0);
    expect(childEvents.every((row) => row.agent === "task-b1")).toBe(true);
    // 子 Run 的 seq 从 0 开始独立计数
    const childSeqs = childEvents.map((row) => row.seq).sort((a, b) => a - b);
    expect(childSeqs).toEqual(Array.from({ length: childSeqs.length }, (_, i) => i));

    // 父 Run ledger 只有 main 的事件
    const parentEvents = eventsRepo.listByRun("parent-run", { limit: 500 });
    expect(parentEvents.every((row) => row.agent === "main")).toBe(true);
    expect(parentEvents).toHaveLength(1); // 只有 route 侧那条 run_started
  });
});

describe("run observability(T49)harness 事件", () => {
  it("reactive compact retry:同一 Step 两次尝试是两组事件,attempt 1 → 2", async () => {
    const events: AgentTelemetryEvent[] = [];
    let callIndex = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const call = callIndex;
        callIndex += 1;
        if (call === 0) {
          // step 0:tool-call(echo)
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "tc-1", toolName: "echo" },
                {
                  type: "tool-call",
                  toolCallId: "tc-1",
                  toolName: "echo",
                  input: JSON.stringify({ msg: "x" })
                },
                { type: "finish", finishReason: "tool-calls", usage }
              ]
            })
          };
        }
        if (call === 1) {
          // step 1:纯文本 stop → notice 续跑(messages 长出运行时段,供 reactive compact 压缩)
          return { stream: simulateReadableStream({ chunks: textChunks("first answer") }) };
        }
        if (call === 2) {
          // 续跑圈 step 2 attempt 1:上下文溢出 → reactive compact 后重跑
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "error", error: new Error("context length exceeded") }
              ]
            })
          };
        }
        // attempt 2:成功
        return { stream: simulateReadableStream({ chunks: textChunks("ok") }) };
      }
    });

    // 第一次 drain 注入一条 notice 触发续跑圈,之后清空。(max-output 续写在
    // MockLanguageModelV4 下端到端触发不了 —— finishReason 被归一成 other,
    // 见 lead-agent-loop.test.ts:250 的同款结论。)
    let noticeLeft = 1;
    const agent = createAgent({
      model,
      tools: [echoTool],
      maxSteps: 10,
      observer: (event) => events.push(event)
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "hi" }],
      drainNotices: async () => {
        if (noticeLeft > 0) {
          noticeLeft -= 1;
          return [{ text: "background subagent reported something" }];
        }
        return [];
      }
    });
    expect(result.text).toContain("ok");

    const failed = events.filter((e) => e.type === "model_call_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ step: 2, attempt: 1, willRetry: true });

    const stepTwoStarts = events.filter(
      (e) => e.type === "step_started" && e.step === 2
    );
    expect(stepTwoStarts.map((e) => (e.type === "step_started" ? e.attempt : 0))).toEqual([1, 2]);

    expect(events.some((e) => e.type === "context_compacted")).toBe(true);
    expect(
      events.some(
        (e) => e.type === "loop_transition" && e.reason === "reactive_compact_retry"
      )
    ).toBe(true);
  });

  it("observer 抛错不拖垮 agent loop;fanout 一个订阅者炸了另一个照常", async () => {
    const agent = createAgent({
      model: textModel("still alive"),
      tools: [],
      maxSteps: 3,
      observer: () => {
        throw new Error("observer exploded");
      }
    });
    const result = await agent.invoke({ messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toContain("still alive");

    const received: string[] = [];
    const combined = fanout(
      () => {
        throw new Error("bad subscriber");
      },
      (event) => {
        received.push(event.type);
      }
    );
    combined({ type: "agent_run_start" });
    expect(received).toEqual(["agent_run_start"]);
  });

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
      const bridge = createObserverBridge(recorder);
      const observer = bridge.forAgent("main");

      const snapshot = {
        type: "request_snapshot" as const,
        provider: "openai",
        modelId: "gpt-4o",
        callSettings: { temperature: 0.1 },
        systemPrompt: "you are helpful",
        tools: [{ name: "echo", description: "回显" }]
      };
      observer(snapshot);
      observer(snapshot); // 全同 → ref
      observer({ ...snapshot, systemPrompt: "you are terse" }); // 变了 → 新正文

      const rows = new RunEventRepository(db).listByRun("r-1", { limit: 10 }).reverse();
      expect(rows.map((row) => row.kind)).toEqual([
        "request_snapshot",
        "request_snapshot_ref",
        "request_snapshot"
      ]);
      const ref = JSON.parse(rows[1]!.payload) as { refSeq: number };
      expect(ref.refSeq).toBe(rows[0]!.seq);
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
