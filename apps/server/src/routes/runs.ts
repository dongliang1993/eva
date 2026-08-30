import type { FastifyInstance } from "fastify";
import { toErrorMessage } from "@eva/shared";

import { AgentUnavailableError } from "../services/agent-factory.js";
import { RunCoordinator } from "../services/runs/run-coordinator.js";
import { SessionBusyError } from "../services/runs/run-preparation.js";
import { RunEventStream } from "../transports/sse/event-stream.js";

/**
 * Run 的三条 HTTP 端点 —— **只做协议翻译**(宪法 C2)。
 *
 * 这个文件里没有业务顺序:一次 Run 怎么跑在 services/runs/run-coordinator.ts。
 * 留在这里的只有三样东西:SSE 连接的建立、`RunOutcome` → HTTP 状态码的映射、
 * 以及注册表查询的 404 语义。
 */
export const registerRunRoutes = (app: FastifyInstance): void => {
  // 依赖都是进程级的 —— 一个实例服务所有请求,per-run 状态活在 coordinator.run() 里面。
  const coordinator = new RunCoordinator({
    config: app.infra.config,
    db: app.infra.db,
    logger: app.log,
    skills: app.infra.skills,
    baseObserver: app.infra.observer,
    agents: app.services.agents,
    session: app.services.session,
    approvals: app.services.approvals,
    approvalPolicies: app.services.approvalPolicies,
    runLedger: app.services.runLedger,
    runRegistry: app.services.runRegistry,
    workspaces: app.services.workspaces,
    planWeave: app.services.planWeave,
    mcp: app.services.mcp
  });

  app.post("/api/v1/runs/stream", async (request, reply) => {
    const outcome = await coordinator.run(
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
    const hub = app.services.runRegistry.hubFor(runId);

    // 404 是正常语义:run 在刷新与这次请求之间跑完了 —— 前端退回只读 DB 消息。
    if (!hub) {
      reply.code(404);
      return { error: "run not found or already finished" };
    }

    const stream = new RunEventStream(reply);
    stream.open();
    const done = hub.attach(stream, { replay: true });
    stream.onDisconnect(() => hub.detach(stream));

    await done;

    return undefined;
  });

  app.post("/api/v1/runs/:runId/abort", async (request, reply) => {
    const { runId } = request.params as { runId: string };

    if (!app.services.runRegistry.abort(runId)) {
      reply.code(404);
      return { error: "run not found or already finished" };
    }

    // 中止时立刻拒绝该 run 下 pending 的审批,否则 agent loop 会被吊住
    app.services.approvals.cancelByRun(runId);

    return { ok: true };
  });
};
