import type { AppInfrastructure, AppServices } from "../types/common.js";
import { RunFinalizer } from "../services/runs/run-finalizer.js";
import {
  RunCoordinator,
  type RunOutcome,
  type RunRequestLog
} from "../services/runs/run-coordinator.js";
import type { RunEventStream } from "../transports/sse/event-stream.js";

export type { RunOutcome, RunRequestLog };

export interface RunsApi {
  /**
   * 开一次 Run。**不抛** —— 失败的台账在里面收好了,返回值只告诉调用方
   * 还能不能回 HTTP 状态码(见 RunOutcome)。
   */
  start(body: unknown, stream: RunEventStream, log: RunRequestLog): Promise<RunOutcome>;
  /**
   * 重新挂到一个在飞的 run 上 —— 刷新页面后续跟流。
   *
   * 返回 false = run 在刷新与这次请求之间跑完了(正常语义,调用方回 404,
   * 前端退回只读 DB 消息)。返回 true 时这个 Promise 直到订阅者退场或 run 收尾才兑现。
   */
  attach(runId: string, stream: RunEventStream): Promise<boolean>;
  /** 中止。返回 false = run 不在飞。 */
  abort(runId: string): boolean;
}

export const createRunsApi = (infra: AppInfrastructure, services: AppServices): RunsApi => {
  const coordinator = new RunCoordinator({
    config: infra.config,
    db: infra.db,
    logger: infra.logger,
    skills: infra.skills,
    baseObserver: infra.observer,
    agents: services.agents,
    session: services.session,
    approvals: services.approvals,
    approvalPolicies: services.approvalPolicies,
    runLedger: services.runLedger,
    runRegistry: services.runRegistry,
    workspaces: services.workspaces,
    planWeave: services.planWeave,
    mcp: services.mcp,
    // 终态的构造权留在组合根这一侧。coordinator 只拿到这个工厂,拿不到
    // RunSettlingLedger —— 于是「在 catch 里顺手 fail 一下」编译不过(§7.2)。
    createFinalizer: (binding) =>
      new RunFinalizer({
        ...binding,
        runLedger: services.runLedger,
        session: services.session,
        runRegistry: services.runRegistry,
        approvals: services.approvals
      })
  });

  return {
    start: (body, stream, log) => coordinator.run(body, stream, log),

    attach: async (runId, stream) => {
      const hub = services.runRegistry.hubFor(runId);
      if (!hub) return false;

      stream.open();
      const done = hub.attach(stream, { replay: true });
      stream.onDisconnect(() => hub.detach(stream));
      await done;

      return true;
    },

    abort: (runId) => {
      if (!services.runRegistry.abort(runId)) return false;

      // 中止时立刻拒绝该 run 下 pending 的审批,否则 agent loop 会被吊住。
      services.approvals.cancelByRun(runId);

      return true;
    }
  };
};
