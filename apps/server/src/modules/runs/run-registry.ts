import { RunHub } from "./run-hub.js";

interface RunEntry {
  readonly controller: AbortController;
  readonly hub: RunHub;
}

/**
 * run 级注册表:runId → { AbortController, 事件枢纽 }。
 *
 * **不持有 sessionId** —— 审批的归属键是 runId(见 ApprovalGateway.cancelByRun),
 * 让这个注册表知道会话只会诱惑调用方把它当归属源用。
 *
 * 枢纽放在这里的原因:重连路由(GET /runs/:runId/stream)只有 runId,
 * 它需要一个进程内的地方按 runId 找到在飞 run 的事件源。
 */
export class RunRegistry {
  private readonly runs = new Map<string, RunEntry>();

  register(runId: string): AbortController {
    const controller = new AbortController();
    this.runs.set(runId, { controller, hub: new RunHub(runId) });
    return controller;
  }

  /** 该 run 的事件枢纽 —— 未注册/已结束返回 undefined(重连路由据此回 404)。 */
  hubFor(runId: string): RunHub | undefined {
    return this.runs.get(runId)?.hub;
  }

  /** @returns 是否真的中止了一次在飞的 run(未注册/已结束返回 false)。 */
  abort(runId: string): boolean {
    const entry = this.runs.get(runId);

    if (!entry) {
      return false;
    }

    entry.controller.abort();
    return true;
  }

  unregister(runId: string): void {
    // 兜底:路由正常收尾时已经 closeAll 过,异常路径靠这里不留悬挂的订阅者。
    this.runs.get(runId)?.hub.closeAll();
    this.runs.delete(runId);
  }
}
