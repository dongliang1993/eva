import { RunHub } from "./run-hub.js";

interface RunEntry {
  readonly controller: AbortController;
  readonly hub: RunHub;
  readonly done: Promise<void>;
  readonly resolve: () => void;
}

export class RunRegistry {
  private readonly runs = new Map<string, RunEntry>();
  private closing = false;

  register(runId: string): AbortController {
    if (this.closing) throw Object.assign(new Error("Server is shutting down"), { statusCode: 503 });
    const controller = new AbortController();
    let resolve!: () => void;
    const done = new Promise<void>(complete => { resolve = complete; });
    this.runs.set(runId, { controller, hub: new RunHub(runId), done, resolve });
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

  async close(): Promise<void> {
    this.closing = true;
    const entries = [...this.runs.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map(entry => entry.done));
  }

  unregister(runId: string): void {
    // 兜底:路由正常收尾时已经 closeAll 过,异常路径靠这里不留悬挂的订阅者。
    this.runs.get(runId)?.hub.closeAll();
    this.runs.get(runId)?.resolve();
    this.runs.delete(runId);
  }
}
