import type { EvaUIMessage, RunStreamEvent } from "@eva/shared";
import { replayEventsFor } from "@eva/shared";

import type { RunEventStream } from "../../transports/sse/event-stream.js";

export interface RunHubBinding {
  readonly sessionId: string;
  /** 当前在飞 assistant 消息的快照;还没开始流则 undefined。 */
  readonly snapshot: () => EvaUIMessage | undefined;
}

/**
 * 一次 run 的事件枢纽 —— 把「run 的生命」与「某条 SSE 连接的生命」拆开。
 *
 * 断连只是少了一个观众:订阅者退场,run 照常跑,页面回来后重新 attach,
 * 服务端把已经流过的部分反推成合成帧补给它(replayEventsFor),后续新帧继续扇出。
 *
 * seq 刻意留在每条连接上(RunEventStream 自己的计数器):web 侧
 * DeltaAccumulator 从 lastSeq = 0 起严格连号,重连流的第一帧必须是 seq 1,
 * 否则会永远卡在 pending 里。
 */
export class RunHub {
  private readonly subscribers = new Set<RunEventStream>();
  /** attach 返回的 promise 的 resolver —— detach / closeAll 时兑现。 */
  private readonly waiters = new Map<RunEventStream, () => void>();
  private binding: RunHubBinding | undefined;
  private closed = false;

  constructor(private readonly runId: string) {}

  /** run 跑起来之后才知道会话与快照来源。 */
  bind(binding: RunHubBinding): void {
    this.binding = binding;
  }

  /**
   * 挂一个订阅者上来。
   *
   * `replay: true` = 重连:先补 run_start 与历史帧,再加入扇出集合。**中间不能出现
   * `await`** —— 单线程下「补历史 + 入集合」因此是原子的,不会漏掉这期间的新帧。
   *
   * @returns 该订阅者退场(detach 或 closeAll)时 resolve —— GET 路由 await 它挂住响应。
   */
  attach(stream: RunEventStream, opts: { readonly replay: boolean }): Promise<void> {
    if (this.closed) {
      stream.close();
      return Promise.resolve();
    }

    if (opts.replay) {
      const snapshot = this.binding?.snapshot();

      stream.emit({
        type: "run_start",
        runId: this.runId,
        sessionId: this.binding?.sessionId ?? ""
      });

      if (snapshot) {
        for (const event of replayEventsFor(snapshot)) {
          stream.emit(event);
        }
      }
    }

    this.subscribers.add(stream);

    return new Promise<void>((resolve) => {
      this.waiters.set(stream, resolve);
    });
  }

  /** 订阅者退场(断连或路由收尾)。run 不受影响。 */
  detach(stream: RunEventStream): void {
    this.subscribers.delete(stream);
    this.waiters.get(stream)?.();
    this.waiters.delete(stream);
  }

  /** 扇出给所有订阅者。死掉的 socket 由 RunEventStream.emit 自己吞掉。 */
  publish(event: RunStreamEvent): void {
    for (const stream of [...this.subscribers]) {
      stream.emit(event);
    }
  }

  /** run 终态:关掉所有订阅者并兑现各自的 attach promise。 */
  closeAll(): void {
    this.closed = true;

    for (const stream of [...this.subscribers]) {
      stream.close();
      this.detach(stream);
    }
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
