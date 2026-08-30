import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "../../../apps/server/node_modules/fastify/fastify.js";
import type { FastifyInstance } from "../../../apps/server/node_modules/fastify";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { createAgent, type Agent } from "../../../packages/harness/src/index.js";
import type { RunStreamFrame } from "../../../packages/shared/src/index.js";
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

/** 一次跑得够久的 run —— 断连、重连、abort 都要在它还在飞的时候发生。 */
const slowAgent = (): Agent =>
  createAgent({
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "一" },
            { type: "text-delta", id: "1", delta: "二" },
            { type: "text-delta", id: "1", delta: "三" },
            { type: "text-delta", id: "1", delta: "四" },
            { type: "text-end", id: "1" },
            { type: "finish", finishReason: "stop", usage }
          ],
          chunkDelayInMs: 120
        })
      })
    }),
    tools: [],
    maxSteps: 3
  });

let app: FastifyInstance;
let db: AppDatabase;
let base: string;
let registry: RunRegistry;
let approvals: ApprovalGateway;

beforeEach(async () => {
  db = initDb({ dbPath: ":memory:" });
  migrateDb(db);

  registry = new RunRegistry();
  approvals = new ApprovalGateway(new ApprovalRepository(db));
  const agent = slowAgent();

  app = Fastify();
  app.decorate("infra", { config: loadConfig({ env: {}, cwd: "/tmp" }), db, skills: [] });
  app.decorate("services", {
    agents: { build: () => ({ agent, mainModel: { qualifiedModelId: "openai:test" } }) },
    session: new SessionService(
      new DrizzleSessionRepository(db),
      new DrizzleMessageRepository(db)
    ),
    approvals,
    runLedger: new RunLedger(new DrizzleRunRepository(db)),
    runRegistry: registry,
    mcp: { ensureConnected: async () => {}, listTools: () => [] }
  });
  decorateAppApi(app);
  registerRunRoutes(app);

  // app.inject 永远不会断连 —— 这条路径只有真 socket 能测。
  base = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  await app.close();
  closeDb(db);
});

const readFrames = async (
  response: Response,
  until: (frame: RunStreamFrame) => boolean
): Promise<RunStreamFrame[]> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: RunStreamFrame[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const frame = JSON.parse(line.slice(6)) as RunStreamFrame;
      frames.push(frame);
      if (until(frame)) {
        void reader.cancel();
        return frames;
      }
    }
  }

  return frames;
};

const runRow = (runId: string) =>
  new DrizzleRunRepository(db).findBySessionId(
    new DrizzleSessionRepository(db).listAll(5)[0]!.id
  ).find((row) => row.id === runId);

const waitUntil = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** 断连后拿到 runId,并确认 run 仍在飞。 */
const startAndDisconnect = async (): Promise<string> => {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/v1/runs/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ text: "hi", modelId: "openai:test" }),
    signal: abort.signal
  });

  const frames = await readFrames(response, (frame) => frame.type === "text-delta");
  const runStart = frames.find((f) => f.type === "run_start") as { runId: string } | undefined;
  expect(runStart?.runId).toBeTruthy();

  abort.abort(); // ← 刷新页面
  await new Promise((resolve) => setTimeout(resolve, 30));

  return runStart!.runId;
};

/**
 * 方案 A 的核心不变量:断连只是少了一个观众。
 * 这里红了,就说明「刷新页面 = 杀掉 run」又回来了。
 */
describe("SSE 断连不再终止 run", () => {
  it("断连后 run 仍在注册表里、DB 行仍 running,最终自己跑完", async () => {
    const runId = await startAndDisconnect();

    expect(registry.hubFor(runId)).toBeDefined();
    expect(runRow(runId)?.status).toBe("running");

    await waitUntil(() => runRow(runId)?.status === "completed");
    // 没人看的时候也把回复落库了。
    expect(runRow(runId)?.assistantMessageId).toBeTruthy();
  });

  it("断连不取消 pending 审批(只有 stop / 决策 / 进程重启能收)", async () => {
    const abort = new AbortController();
    const response = await fetch(`${base}/api/v1/runs/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ text: "hi", modelId: "openai:test" }),
      signal: abort.signal
    });
    const frames = await readFrames(response, (frame) => frame.type === "text-delta");
    const { runId, sessionId } = frames.find((f) => f.type === "run_start") as unknown as {
      runId: string;
      sessionId: string;
    };

    void approvals.ask("call-1", { runId, sessionId, tool: "bash", args: {} });

    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(approvals.listPending(sessionId).map((p) => p.callId)).toEqual(["call-1"]);
    expect(new ApprovalRepository(db).getById("call-1")?.status).toBe("pending");
  });

  it("只有 POST /runs/:runId/abort 能终止 detached run", async () => {
    const runId = await startAndDisconnect();

    const aborted = await fetch(`${base}/api/v1/runs/${runId}/abort`, { method: "POST" });
    expect(aborted.status).toBe(200);

    await waitUntil(() => runRow(runId)?.status === "aborted");
  });
});

describe("GET /runs/:runId/stream 重连", () => {
  it("重连拿到 run_start + 重放帧 + 后续新帧 + end", async () => {
    const runId = await startAndDisconnect();

    const response = await fetch(`${base}/api/v1/runs/${runId}/stream`, {
      headers: { accept: "text/event-stream" }
    });
    expect(response.status).toBe(200);

    const frames = await readFrames(response, (frame) => frame.type === "end");

    expect(frames[0]).toMatchObject({ type: "run_start", runId, seq: 1 });
    // 重连流自己从 seq 1 连号 —— web 的 DeltaAccumulator 靠这个不卡 pending。
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1));

    const text = frames
      .filter((f) => f.type === "text-delta")
      .map((f) => (f as unknown as { textDelta: string }).textDelta)
      .join("");
    // 断连前流过的部分被重放补齐,而不是从断点接着往下。
    expect(text).toBe("一二三四");
    expect(frames.at(-1)).toMatchObject({ type: "end", finishReason: "stop" });
  });

  it("run 已经跑完 → 404,前端退回只读 DB 消息", async () => {
    const runId = await startAndDisconnect();
    await waitUntil(() => runRow(runId)?.status === "completed");

    const response = await fetch(`${base}/api/v1/runs/${runId}/stream`);
    expect(response.status).toBe(404);
  });
});
