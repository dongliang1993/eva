/**
 * run 级 AbortController 注册表。
 *
 * 只做一件事:runId → controller。**不持有 sessionId** ——
 * 审批的归属键是 runId(见 ApprovalGateway.cancelByRun),
 * 让这个注册表知道会话只会诱惑调用方把它当归属源用。
 */
export class RunRegistry {
  private readonly runs = new Map<string, AbortController>();

  register(runId: string): AbortController {
    const controller = new AbortController();
    this.runs.set(runId, controller);
    return controller;
  }

  /** @returns 是否真的中止了一次在飞的 run(未注册/已结束返回 false)。 */
  abort(runId: string): boolean {
    const controller = this.runs.get(runId);

    if (!controller) {
      return false;
    }

    controller.abort();
    return true;
  }

  /** 该 run 是否仍在飞(T8 的 deriveSessionStatus 会用)。 */
  isRunning(runId: string): boolean {
    return this.runs.has(runId);
  }

  unregister(runId: string): void {
    this.runs.delete(runId);
  }
}