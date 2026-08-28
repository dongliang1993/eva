import type { AgentTool } from "./build-tool.js";
import type { ToolTimingState } from "./tool-timing.js";

/** 只读工具的默认并发帽(Claude Code 同款默认)。 */
export const DEFAULT_READ_ONLY_CONCURRENCY = 10;

/**
 * 无依赖的 FIFO 信号量(T24)。
 *
 * 不用 p-limit:依赖树多一个包换 50 行手写,而手写版把 FIFO 语义钉死
 * (p-limit 的队列策略在迭代版本间变过)。不可重入是设计 —— 工具 execute
 * 不会嵌套调自己,做成可重入反而让"同一步同工具两个调用"绕帽。
 * acquire 返回的 release 幂等,必须在 finally 里调用(见 withConcurrencyCap)。
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

/**
 * 把只读工具的 execute 包进信号量(T24 装配层限流)。
 *
 * 只帽 `readOnly === true` 的工具 —— 写类/未标工具直通:写工具的正确性由
 * T23 写守卫兜底,不该排队;宁可漏帽不可误帽(把写类误帽进只读队列 =
 * T23 白做)。release 在 finally:一个 throw 的工具把帽带崩,后续只读调用
 * 全饿死,表象是"agent 越跑越慢",极难归因。
 */
export const withConcurrencyCap = (
  agentTool: AgentTool,
  limiter: Semaphore,
  timing?: ToolTimingState
): AgentTool => {
  if (agentTool.readOnly !== true) {
    return agentTool;
  }

  const inner = agentTool.tool;
  const innerExecute = inner.execute;

  if (typeof innerExecute !== "function") {
    return agentTool;
  }

  return {
    ...agentTool,
    tool: {
      ...inner,
      execute: async (input: unknown, options?: unknown) => {
        // T50:排队等待单独成段 —— 无竞争时是 0,不是 undefined。
        const queueStart = Date.now();
        const release = await limiter.acquire();
        const toolCallId = (options as { toolCallId?: string } | undefined)?.toolCallId;
        if (toolCallId !== undefined) {
          timing?.record(toolCallId, "queue", Date.now() - queueStart);
        }
        try {
          return await innerExecute(input as never, options as never);
        } finally {
          release();
        }
      },
    } as typeof inner,
  };
};
