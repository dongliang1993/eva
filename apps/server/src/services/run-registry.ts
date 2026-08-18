interface RunHandle {
  readonly controller: AbortController;
  readonly sessionId: string;
}

export class RunRegistry {
  private readonly runs = new Map<string, RunHandle>();

  register(runId: string, sessionId = ""): AbortController {
    const controller = new AbortController();
    this.runs.set(runId, { controller, sessionId });
    return controller;
  }

  /**
   * 中止一次 run。
   * @returns 该 run 绑定的 sessionId(路由据此取消该会话下 pending 的审批);找不到返回 undefined。
   */
  abort(runId: string): string | undefined {
    const handle = this.runs.get(runId);
    if (!handle) {
      return undefined;
    }
    handle.controller.abort();
    return handle.sessionId;
  }

  unregister(runId: string): void {
    this.runs.delete(runId);
  }
}