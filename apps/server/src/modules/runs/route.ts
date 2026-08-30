import type { FastifyInstance } from "fastify";
import { toErrorMessage } from "@eva/shared";

import { AgentUnavailableError } from "./agent-factory.js";
import { SessionBusyError } from "./run-preparation.js";
import { RunEventStream } from "../../transports/sse/event-stream.js";

const RUN_GONE = { error: "run not found or already finished" } as const;

/**
 * Run 的三条 HTTP 端点 —— **只做协议翻译**(宪法 C2)。
 *
 * 这个文件里没有业务顺序,也没有装配:一次 Run 怎么跑在
 * 业务顺序在 run-coordinator.ts，依赖装配在本模块 api.ts。
 * 留在这里的只有 SSE 连接的建立、`RunOutcome` → HTTP 状态码、以及 404 语义。
 */
export const registerRunRoutes = (app: FastifyInstance): void => {
  app.post("/api/v1/runs/stream", async (request, reply) => {
    const outcome = await app.api.runs.start(
      request.body,
      new RunEventStream(reply),
      request.log
    );

    // streamed = SSE 头已经发过,收尾(含错误帧)也已经从流里告知 —— 这里无事可做。
    if (outcome.kind === "streamed") {
      return undefined;
    }

    // rejected = 流还没开就失败了,台账已由 finalizer 收好,只剩状态码要翻译。
    const { error } = outcome;

    // 409 带上 activeRunId:前端据此直接挂到在跑的那个 run 上,不用再查一次 status。
    if (error instanceof SessionBusyError) {
      reply.code(409);

      return { error: toErrorMessage(error), activeRunId: error.activeRunId };
    }

    reply.code(error instanceof AgentUnavailableError ? 503 : 400);

    return { error: toErrorMessage(error) };
  });

  /**
   * 重新挂到一个在飞的 run 上 —— 刷新页面后续跟流。
   *
   * 与 POST 同形:handler 里 await 住(RunEventStream 不 hijack reply),
   * 订阅者退场或 run 收尾时 attach 的 promise 兑现,handler 才返回。
   */
  app.get("/api/v1/runs/:runId/stream", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    // 404 是正常语义:run 在刷新与这次请求之间跑完了 —— 前端退回只读 DB 消息。
    if (!(await app.api.runs.attach(runId, new RunEventStream(reply)))) {
      reply.code(404);
      return RUN_GONE;
    }

    return undefined;
  });

  app.post("/api/v1/runs/:runId/abort", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    if (!app.api.runs.abort(runId)) {
      reply.code(404);
      return RUN_GONE;
    }

    return { ok: true };
  });
};
